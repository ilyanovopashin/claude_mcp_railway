require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://admin.chatme.ai/connector/webim/webim_message/b453dc519e33a90c9ca6d3365445f3d3/bot_api_webhook';

const connections = new Map();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const extractSessionId = req =>
  req.query.sessionId || req.query.session || req.headers['x-session-id'];

const ensureSessionId = (req, { createIfMissing = false, context = 'session' } = {}) => {
  const provided = extractSessionId(req);

  if (provided) {
    if (UUID_REGEX.test(provided)) {
      return provided;
    }

    console.warn(`[${context}] Ignoring non-UUID session id: ${provided}`);
  }

  if (!createIfMissing) {
    return null;
  }

  const generated = randomUUID();
  console.log(`[${context}] Generated new session id: ${generated}`);
  return generated;
};

app.use(cors());
app.use(express.json());

// IMPORTANT: MCP SSE Transport requires:
// 1. GET endpoint for SSE connection
// 2. Server sends "endpoint" event with POST URL
// 3. Client uses that POST URL for all requests

// SSE Connection Endpoint (GET)
const sendSseEvent = (sessionId, event, data) => {
  const connection = connections.get(sessionId);

  if (!connection) {
    console.warn(`[SSE] No active connection for session ${sessionId}`);
    return false;
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const eventLine = event ? `event: ${event}\n` : '';
  connection.write(`${eventLine}data: ${payload}\n\n`);
  return true;
};

app.get('/sse', async (req, res) => {
  const sessionId = ensureSessionId(req, {
    createIfMissing: true,
    context: 'sse'
  });
  
  console.log('='.repeat(80));
  console.log(`[SSE GET] New connection`);
  console.log(`[SSE GET] Session: ${sessionId}`);
  console.log(`[SSE GET] Time: ${new Date().toISOString()}`);
  console.log(`[SSE GET] Host: ${req.get('host')}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  connections.set(sessionId, res);
  console.log(`[SSE GET] Stored connection. Active: ${connections.size}`);

  // CRITICAL: Send endpoint event first!
  // This tells the client where to POST messages
  const fullUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  const messagePathname = fullUrl.pathname.replace(/\/[^/]*$/, '/message');
  const messagePath = `${messagePathname}?sessionId=${encodeURIComponent(
    sessionId
  )}`;

  console.log(`[SSE GET] Sending endpoint path: ${messagePath}`);
  sendSseEvent(sessionId, 'endpoint', messagePath);
  console.log(`[SSE GET] Endpoint path sent!`);

  req.on('close', () => {
    console.log(`[SSE GET] Connection closed: ${sessionId}`);
    connections.delete(sessionId);
  });
});

// Message Endpoint (POST) - This is where client sends requests
const handleMcpMessage = async (req, res) => {
  console.log('='.repeat(80));
  console.log(`[MCP POST] ${req.method} ${req.originalUrl}`);
  console.log(`[MCP POST] Time: ${new Date().toISOString()}`);
  console.log(`[MCP POST] Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`[MCP POST] Body:`, JSON.stringify(req.body, null, 2));

  const sessionId = ensureSessionId(req, { context: 'post' });
  if (!sessionId) {
    console.error('[MCP POST] Missing or invalid session id');
    return res.status(400).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: {
        code: -32602,
        message: 'Missing or invalid sessionId (must be UUID)'
      }
    });
  }
  console.log(`[MCP POST] Session: ${sessionId}`);

  try {
    const mcpRequest = req.body;

    // Validate JSON-RPC
    if (!mcpRequest || mcpRequest.jsonrpc !== '2.0') {
      console.error(`[MCP POST] Invalid JSON-RPC format`);
      return res.status(400).json({
        jsonrpc: '2.0',
        id: mcpRequest?.id || null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    console.log(`[MCP POST] Method: ${mcpRequest.method}`);
    console.log(`[MCP POST] ID: ${mcpRequest.id}`);

    // Handle initialize specially
    if (mcpRequest.method === 'initialize') {
      console.log(`[MCP POST] Handling initialize request`);
      const initResponse = {
        jsonrpc: '2.0',
        id: mcpRequest.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'chatmi-mcp-server',
            version: '1.0.0'
          }
        }
      };

      console.log(`[MCP POST] Sending initialize response:`, JSON.stringify(initResponse, null, 2));

      // Check if client wants SSE response
      if (sendSseEvent(sessionId, 'message', initResponse)) {
        console.log(`[MCP POST] Initialize response sent via SSE to ${sessionId}`);
        return res.status(202).json({ status: 'sent via SSE' });
      }

      console.warn('[MCP POST] No SSE connection; falling back to HTTP response');
      return res.json(initResponse);
    }

    // For all other methods, forward to Chatmi
    console.log(`[MCP POST] Forwarding to Chatmi...`);

    const inputString = JSON.stringify({
      method: mcpRequest.method,
      params: mcpRequest.params || {},
      id: mcpRequest.id
    });

    console.log(`[Chatmi] Request: ${inputString}`);

    const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'new_message',
        chat: { id: sessionId },
        text: inputString
      })
    });

    console.log(`[Chatmi] Status: ${chatmiResponse.status}`);

    if (!chatmiResponse.ok) {
      const errorText = await chatmiResponse.text();
      console.error(`[Chatmi] Error: ${errorText}`);
      throw new Error(`Chatmi HTTP ${chatmiResponse.status}: ${errorText}`);
    }

    const chatmiData = await chatmiResponse.json();
    console.log(`[Chatmi] Response:`, JSON.stringify(chatmiData, null, 2));
    
    if (!chatmiData.has_answer || chatmiData.messages.length === 0) {
      throw new Error('No response from Chatmi');
    }

    const outputString = chatmiData.messages[0].text;
    console.log(`[Chatmi] Output: ${outputString}`);

    let result;
    try {
      result = JSON.parse(outputString);
      console.log(`[Chatmi] Parsed:`, JSON.stringify(result, null, 2));
    } catch (parseError) {
      console.error(`[Chatmi] Parse error:`, parseError);
      result = { text: outputString };
    }

    const mcpResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result
    };

    console.log(`[MCP POST] MCP Response:`, JSON.stringify(mcpResponse, null, 2));

    // Check if client wants SSE response
    if (sendSseEvent(sessionId, 'message', mcpResponse)) {
      console.log(`[MCP POST] Response sent via SSE to session: ${sessionId}`);
      return res.status(202).json({ status: 'sent via SSE', sessionId });
    }

    console.warn('[MCP POST] No SSE connection; falling back to HTTP response');
    return res.json(mcpResponse);

  } catch (error) {
    console.error(`[MCP POST] Error:`, error);
    console.error(`[MCP POST] Stack:`, error.stack);
    const errorResponse = {
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: {
        code: -32603,
        message: error.message
      }
    };

    if (sendSseEvent(sessionId, 'error', errorResponse)) {
      console.log(`[MCP POST] Error sent via SSE to session: ${sessionId}`);
      return res.status(202).json({ status: 'error sent via SSE', sessionId });
    }

    return res.status(500).json(errorResponse);
  }
};

app.post('/sse', handleMcpMessage);
app.post('/message', handleMcpMessage);

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connections: connections.size,
    sessions: Array.from(connections.keys()),
    chatmi: CHATMI_ENDPOINT ? 'configured' : 'default',
    timestamp: new Date().toISOString()
  });
});

// Test Chatmi connectivity
app.post('/test/chatmi', async (req, res) => {
  try {
    console.log('[Test] Testing Chatmi connection...');
    
    const testPayload = {
      event: 'new_message',
      chat: { id: 'test' },
      text: JSON.stringify({
        method: 'tools/list',
        params: {},
        id: 1
      })
    };
    
    console.log('[Test] Sending:', testPayload);
    
    const response = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    
    console.log('[Test] Status:', response.status);
    
    const data = await response.json();
    console.log('[Test] Response:', data);
    
    // Try to parse the text field
    let parsedText = null;
    if (data.has_answer && data.messages && data.messages[0]) {
      try {
        parsedText = JSON.parse(data.messages[0].text);
      } catch (e) {
        parsedText = data.messages[0].text;
      }
    }
    
    res.json({ 
      success: true,
      chatmiEndpoint: CHATMI_ENDPOINT,
      rawResponse: data,
      parsedTools: parsedText
    });
  } catch (error) {
    console.error('[Test] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      chatmiEndpoint: CHATMI_ENDPOINT
    });
  }
});

app.listen(PORT, () => {
  console.log('='.repeat(80));
  console.log(`🚀 MCP-Chatmi Proxy Server`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔌 SSE Endpoint: /sse`);
  console.log(`   - GET /sse   → Open SSE connection`);
  console.log(`   - POST /sse  → Send MCP messages`);
  console.log(`❤️  Health: /health`);
  console.log(`🧪 Test: POST /test/chatmi`);
  console.log(`🔧 Chatmi: ${CHATMI_ENDPOINT}`);
  console.log('='.repeat(80));
});
