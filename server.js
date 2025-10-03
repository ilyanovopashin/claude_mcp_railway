// server.js - Full Node.js server for proper MCP SSE support
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://webhook.site/680446d6-b95c-4170-8e17-680f18f3a5e0';

// Store active SSE connections
const connections = new Map();

app.use(cors());
app.use(express.json());

// SSE endpoint - GET /sse
app.get('/sse', (req, res) => {
  const sessionId = req.query.session || `session-${Date.now()}`;
  
  console.log(`[SSE Connected] Session: ${sessionId}`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection event
  res.write(`data: ${JSON.stringify({
    type: 'connection',
    sessionId,
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Store this connection
  connections.set(sessionId, res);

  // Keep-alive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    res.write(':ping\n\n');
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[SSE Disconnected] Session: ${sessionId}`);
    clearInterval(keepAliveInterval);
    connections.delete(sessionId);
  });
});

// Message endpoint - POST /message
app.post('/message', async (req, res) => {
  try {
    const mcpRequest = req.body;
    const sessionId = req.query.session || req.headers['x-session-id'];

    console.log('[MCP Request]', JSON.stringify(mcpRequest));
    console.log('[Session ID]', sessionId);

    // Validate JSON-RPC format
    if (mcpRequest.jsonrpc !== '2.0' || !mcpRequest.method) {
      console.error('[Validation Error] Invalid MCP request format');
      return res.status(400).json({
        jsonrpc: '2.0',
        id: mcpRequest.id || null,
        error: {
          code: -32600,
          message: 'Invalid Request'
        }
      });
    }

    // Convert MCP request to Chatmi INPUT_STRING format
    const inputObject = {
      method: mcpRequest.method,
      params: mcpRequest.params || {},
      id: mcpRequest.id
    };
    const inputString = JSON.stringify(inputObject);

    console.log('[Chatmi Input]', inputString);

    // Call Chatmi
    const chatmiPayload = {
      event: 'new_message',
      chat: { id: sessionId || 'mcp-session' },
      text: inputString
    };

    const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatmiPayload)
    });

    if (!chatmiResponse.ok) {
      throw new Error(`Chatmi API error: ${chatmiResponse.status}`);
    }

    const chatmiData = await chatmiResponse.json();
    
    if (!chatmiData.has_answer || chatmiData.messages.length === 0) {
      throw new Error('No response from Chatmi');
    }

    const outputString = chatmiData.messages[0].text;
    console.log('[Chatmi Output]', outputString);

    // Parse Chatmi's OUTPUT_STRING
    let result;
    try {
      result = JSON.parse(outputString);
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

    console.log('[MCP Response]', JSON.stringify(mcpResponse));

    // If there's an active SSE connection, send via SSE
    if (sessionId && connections.has(sessionId)) {
      const sseConnection = connections.get(sessionId);
      sseConnection.write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
      return res.status(202).json({ status: 'sent via SSE' });
    }

    // Otherwise return directly as JSON
    return res.status(200).json(mcpResponse);
    
  } catch (error) {
    console.error('[Error]', error);
    const errorResponse = {
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: {
        code: -32603,
        message: error.message || 'Internal error'
      }
    };
    return res.status(500).json(errorResponse);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connections: connections.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 MCP-Chatmi proxy server running on port ${PORT}`);
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`💬 Message endpoint: http://localhost:${PORT}/message`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});
