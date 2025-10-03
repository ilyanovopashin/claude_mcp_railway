require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://admin.chatme.ai/connector/webim/webim_message/a7e28b914256ab13395ec974e7bb9548/bot_api_webhook';

const connections = new Map();

app.use(cors());

// Middleware для логирования всех запросов
app.use((req, res, next) => {
  console.log('='.repeat(80));
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('[Headers]', JSON.stringify(req.headers, null, 2));
  console.log('[Query]', JSON.stringify(req.query, null, 2));
  next();
});

// SSE endpoint
app.all('/sse', express.json(), express.text({ type: '*/*' }), async (req, res) => {
  console.log('[/sse] Method:', req.method);
  console.log('[/sse] Content-Type:', req.headers['content-type']);
  console.log('[/sse] Body type:', typeof req.body);
  console.log('[/sse] Body:', JSON.stringify(req.body, null, 2));
  console.log('[/sse] Raw body:', req.body);

  // Handle POST requests (MCP messages)
  if (req.method === 'POST') {
    try {
      let mcpRequest;
      
      // Try to parse body
      if (typeof req.body === 'string') {
        console.log('[POST] Body is string, parsing...');
        mcpRequest = JSON.parse(req.body);
      } else if (typeof req.body === 'object') {
        console.log('[POST] Body is already object');
        mcpRequest = req.body;
      } else {
        console.log('[POST] Unknown body type:', typeof req.body);
        return res.status(400).json({ error: 'Invalid body format' });
      }

      console.log('[MCP Request]', JSON.stringify(mcpRequest, null, 2));

      const sessionId = req.query.session || req.headers['x-session-id'] || 'default';
      console.log('[Session ID]', sessionId);

      // Validate JSON-RPC format
      if (!mcpRequest || mcpRequest.jsonrpc !== '2.0' || !mcpRequest.method) {
        console.error('[Validation Error] Invalid MCP request format');
        const errorResponse = {
          jsonrpc: '2.0',
          id: mcpRequest?.id || null,
          error: { code: -32600, message: 'Invalid Request' }
        };
        console.log('[Error Response]', JSON.stringify(errorResponse, null, 2));
        return res.status(400).json(errorResponse);
      }

      // Convert MCP request to Chatmi INPUT_STRING format
      const inputString = JSON.stringify({
        method: mcpRequest.method,
        params: mcpRequest.params || {},
        id: mcpRequest.id
      });

      console.log('[Chatmi Input]', inputString);
      console.log('[Calling Chatmi...]', CHATMI_ENDPOINT);

      // Call Chatmi
      const chatmiPayload = {
        event: 'new_message',
        chat: { id: sessionId },
        text: inputString
      };
      
      console.log('[Chatmi Payload]', JSON.stringify(chatmiPayload, null, 2));

      const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatmiPayload)
      });

      console.log('[Chatmi Status]', chatmiResponse.status);
      console.log('[Chatmi Headers]', JSON.stringify(Object.fromEntries(chatmiResponse.headers), null, 2));

      if (!chatmiResponse.ok) {
        const errorText = await chatmiResponse.text();
        console.error('[Chatmi Error Response]', errorText);
        throw new Error(`Chatmi API error: ${chatmiResponse.status} - ${errorText}`);
      }

      const chatmiData = await chatmiResponse.json();
      console.log('[Chatmi Response]', JSON.stringify(chatmiData, null, 2));
      
      if (!chatmiData.has_answer || chatmiData.messages.length === 0) {
        console.error('[Chatmi Error] No answer in response');
        throw new Error('No response from Chatmi');
      }

      const outputString = chatmiData.messages[0].text;
      console.log('[Chatmi Output String]', outputString);

      // Parse Chatmi's OUTPUT_STRING
      let result;
      try {
        result = JSON.parse(outputString);
        console.log('[Parsed Result]', JSON.stringify(result, null, 2));
      } catch (parseError) {
        console.error('[Parse Error]', parseError);
        result = outputString;
      }

      // Create MCP response
      const mcpResponse = {
        jsonrpc: '2.0',
        id: mcpRequest.id,
        result
      };

      console.log('[MCP Response]', JSON.stringify(mcpResponse, null, 2));

      // Check if there's an active SSE connection
      console.log('[Active Sessions]', Array.from(connections.keys()));
      if (connections.has(sessionId)) {
        console.log('[Sending via SSE] to session:', sessionId);
        const sseConnection = connections.get(sessionId);
        sseConnection.write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
        return res.status(202).json({ status: 'sent via SSE', sessionId });
      }

      // If no SSE connection, return directly as JSON
      console.log('[Sending via HTTP] No SSE connection found for session:', sessionId);
      return res.status(200).json(mcpResponse);
      
    } catch (error) {
      console.error('[Error]', error);
      console.error('[Error Stack]', error.stack);
      return res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: { 
          code: -32603, 
          message: error.message || 'Internal error',
          data: error.stack
        }
      });
    }
  }

  // Handle GET requests (SSE connection)
  if (req.method === 'GET') {
    const sessionId = req.query.session || 'default';
    
    console.log(`[SSE] Opening connection for session: ${sessionId}`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial connection event
    const welcomeMessage = {
      type: 'connection',
      sessionId,
      timestamp: new Date().toISOString(),
      message: 'SSE connection established'
    };
    console.log('[SSE] Sending welcome:', welcomeMessage);
    res.write(`data: ${JSON.stringify(welcomeMessage)}\n\n`);

    // Store this connection
    connections.set(sessionId, res);
    console.log(`[SSE] Stored connection. Active connections: ${connections.size}`);
    console.log(`[SSE] Active session IDs:`, Array.from(connections.keys()));

    // Keep-alive ping every 30 seconds
    const keepAliveInterval = setInterval(() => {
      try {
        console.log(`[SSE] Sending keep-alive ping to session: ${sessionId}`);
        res.write(':ping\n\n');
      } catch (error) {
        console.error('[SSE Keep-alive error]', error);
        clearInterval(keepAliveInterval);
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`[SSE] Client disconnected. Session: ${sessionId}`);
      clearInterval(keepAliveInterval);
      connections.delete(sessionId);
      console.log(`[SSE] Active connections: ${connections.size}`);
    });

    return; // Keep connection open
  }

  // Handle other methods
  console.log('[Unknown Method]', req.method);
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const healthData = { 
    status: 'ok', 
    connections: connections.size,
    activeSessionIds: Array.from(connections.keys()),
    timestamp: new Date().toISOString(),
    chatmiEndpoint: CHATMI_ENDPOINT ? 'configured' : 'using default',
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: PORT
    }
  };
  console.log('[Health Check]', healthData);
  res.json(healthData);
});

// Debug endpoint
app.get('/debug/connections', (req, res) => {
  res.json({
    count: connections.size,
    sessions: Array.from(connections.keys()),
    timestamp: new Date().toISOString()
  });
});

// Test endpoint to manually trigger Chatmi
app.post('/test/chatmi', express.json(), async (req, res) => {
  try {
    console.log('[Test] Manual Chatmi test triggered');
    console.log('[Test] Request body:', req.body);
    
    const testPayload = {
      event: 'new_message',
      chat: { id: 'test-session' },
      text: JSON.stringify({
        method: 'tools/list',
        params: {},
        id: 999
      })
    };
    
    console.log('[Test] Sending to Chatmi:', testPayload);
    
    const response = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    
    const data = await response.json();
    console.log('[Test] Chatmi response:', data);
    
    res.json({
      success: true,
      chatmiResponse: data
    });
  } catch (error) {
    console.error('[Test] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log('='.repeat(80));
  console.log(`🚀 MCP-Chatmi proxy server running`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 SSE endpoint: /sse`);
  console.log(`❤️  Health check: /health`);
  console.log(`🔧 Chatmi endpoint: ${CHATMI_ENDPOINT}`);
  console.log(`🧪 Test endpoint: /test/chatmi`);
  console.log('='.repeat(80));
});
