require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://webhook.site/680446d6-b95c-4170-8e17-680f18f3a5e0';

const connections = new Map();

app.use(cors());

// SSE endpoint - handles BOTH GET (connection) and POST (messages)
app.all('/sse', express.json(), async (req, res) => {
  // Handle POST requests (MCP messages from n8n)
  if (req.method === 'POST') {
    try {
      const mcpRequest = req.body;
      const sessionId = req.query.session || req.headers['x-session-id'] || 'default';

      console.log('[MCP Request]', JSON.stringify(mcpRequest));
      console.log('[Session ID]', sessionId);

      // Validate JSON-RPC format
      if (!mcpRequest || mcpRequest.jsonrpc !== '2.0' || !mcpRequest.method) {
        console.error('[Validation Error] Invalid MCP request format');
        return res.status(400).json({
          jsonrpc: '2.0',
          id: mcpRequest?.id || null,
          error: { code: -32600, message: 'Invalid Request' }
        });
      }

      // Convert MCP request to Chatmi INPUT_STRING format
      const inputString = JSON.stringify({
        method: mcpRequest.method,
        params: mcpRequest.params || {},
        id: mcpRequest.id
      });

      console.log('[Chatmi Input]', inputString);

      // Call Chatmi
      const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'new_message',
          chat: { id: sessionId },
          text: inputString
        })
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

      // Check if there's an active SSE connection for this session
      if (connections.has(sessionId)) {
        console.log('[Sending via SSE] to session:', sessionId);
        const sseConnection = connections.get(sessionId);
        sseConnection.write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
        return res.status(202).json({ status: 'sent via SSE', sessionId });
      }

      // If no SSE connection, return directly as JSON
      console.log('[Sending via HTTP] No SSE connection found');
      return res.status(200).json(mcpResponse);
      
    } catch (error) {
      console.error('[Error]', error);
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

  // Handle GET requests (SSE connection from n8n)
  if (req.method === 'GET') {
    const sessionId = req.query.session || 'default';
    
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
    console.log(`[Active Connections]`, connections.size);

    // Keep-alive ping every 30 seconds
    const keepAliveInterval = setInterval(() => {
      try {
        res.write(':ping\n\n');
      } catch (error) {
        console.error('[Keep-alive error]', error);
        clearInterval(keepAliveInterval);
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`[SSE Disconnected] Session: ${sessionId}`);
      clearInterval(keepAliveInterval);
      connections.delete(sessionId);
      console.log(`[Active Connections]`, connections.size);
    });

    return; // Keep connection open
  }

  // Handle other methods
  return res.status(405).json({ error: 'Method not allowed' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connections: connections.size,
    activeSessionIds: Array.from(connections.keys()),
    timestamp: new Date().toISOString(),
    chatmiEndpoint: CHATMI_ENDPOINT ? 'configured' : 'using default'
  });
});

// Debug endpoint to see all connections
app.get('/debug/connections', (req, res) => {
  res.json({
    count: connections.size,
    sessions: Array.from(connections.keys())
  });
});

app.listen(PORT, () => {
  console.log(`🚀 MCP-Chatmi proxy server running on port ${PORT}`);
  console.log(`📡 SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Chatmi endpoint: ${CHATMI_ENDPOINT ? 'Custom' : 'Default'}`);
});
