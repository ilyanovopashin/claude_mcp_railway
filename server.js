require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://admin.chatme.ai/connector/webim/webim_message/b453dc519e33a90c9ca6d3365445f3d3/bot_api_webhook';

const connections = new Map();

app.use(cors());
app.use(express.json());

// IMPORTANT: MCP SSE Transport requires:
// 1. GET endpoint for SSE connection
// 2. Server sends "endpoint" event with POST URL
// 3. Client uses that POST URL for all requests

// SSE Connection Endpoint (GET)
app.get('/sse', async (req, res) => {
  const sessionId =
    req.query.sessionId || req.query.session || `session-${Date.now()}`;
  
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
  const messagePath = `/sse?sessionId=${encodeURIComponent(sessionId)}`;

  console.log(`[SSE GET] Sending endpoint path: ${messagePath}`);
  res.write(`data: ${messagePath}\n\n`);
  console.log(`[SSE GET] Endpoint path sent!`);

  // Keep-alive
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(':ping\n\n');
    } catch (error) {
      console.error(`[SSE GET] Keep-alive error:`, error);
      clearInterval(keepAliveInterval);
    }
  }, 30000);

  req.on('close', () => {
    console.log(`[SSE GET] Connection closed: ${sessionId}`);
    clearInterval(keepAliveInterval);
    connections.delete(sessionId);
  });
});

// Message Endpoint (POST) - This is where client sends requests
app.post('/sse', async (req, res) => {
  console.log('='.repeat(80));
  console.log(`[SSE POST] Message received`);
  console.log(`[SSE POST] Time: ${new Date().toISOString()}`);
  console.log(`[SSE POST] Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`[SSE POST] Body:`, JSON.stringify(req.body, null, 2));
  
  const sessionId =
    req.query.sessionId ||
    req.query.session ||
    req.headers['x-session-id'] ||
    'default';
  console.log(`[SSE POST] Session: ${sessionId}`);
  
  try {
    const mcpRequest = req.body;

    // Validate JSON-RPC
    if (!mcpRequest || mcpRequest.jsonrpc !== '2.0') {
      console.error(`[SSE POST] Invalid JSON-RPC format`);
      return res.status(400).json({
        jsonrpc: '2.0',
        id: mcpRequest?.id || null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    console.log(`[SSE POST] Method: ${mcpRequest.method}`);
    console.log(`[SSE POST] ID: ${mcpRequest.id}`);

    // Handle initialize specially
    if (mcpRequest.method === 'initialize') {
      console.log(`[SSE POST] Handling initialize request`);
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
      
      console.log(`[SSE POST] Sending initialize response:`, JSON.stringify(initResponse, null, 2));
      
      // Check if client wants SSE response
      const acceptHeader = req.get('accept') || '';
      if (acceptHeader.includes('text/event-stream') && connections.has(sessionId)) {
        console.log(`[SSE POST] Sending via SSE`);
        connections.get(sessionId).write(`data: ${JSON.stringify(initResponse)}\n\n`);
        return res.status(202).json({ status: 'sent via SSE' });
      }
      
      console.log(`[SSE POST] Sending via HTTP`);
      return res.json(initResponse);
    }

    // For all other methods, forward to Chatmi
    console.log(`[SSE POST] Forwarding to Chatmi...`);
    
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

    console.log(`[SSE POST] MCP Response:`, JSON.stringify(mcpResponse, null, 2));

    // Check if client wants SSE response
    const acceptHeader = req.get('accept') || '';
    console.log(`[SSE POST] Accept header: ${acceptHeader}`);
    
    if (acceptHeader.includes('text/event-stream') && connections.has(sessionId)) {
      console.log(`[SSE POST] Sending response via SSE to session: ${sessionId}`);
      connections.get(sessionId).write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
      return res.status(202).json({ status: 'sent via SSE', sessionId });
    }

    console.log(`[SSE POST] Sending response via HTTP`);
    return res.json(mcpResponse);
    
  } catch (error) {
    console.error(`[SSE POST] Error:`, error);
    console.error(`[SSE POST] Stack:`, error.stack);
    return res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: { 
        code: -32603, 
        message: error.message
      }
    });
  }
});

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
