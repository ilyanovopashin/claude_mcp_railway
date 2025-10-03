require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  '	https://webhook.site/680446d6-b95c-4170-8e17-680f18f3a5e0';

const connections = new Map();

app.use(cors());
app.use(express.json());

// Main SSE endpoint
app.get('/sse', async (req, res) => {
  const sessionId = req.query.session || `session-${Date.now()}`;
  
  console.log(`========================================`);
  console.log(`[SSE] New connection: ${sessionId}`);
  console.log(`[SSE] Time: ${new Date().toISOString()}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  connections.set(sessionId, res);
  console.log(`[SSE] Active connections: ${connections.size}`);

  // n8n expects the server to automatically fetch and send tools list
  // So let's ask Chatmi for tools/list immediately
  try {
    console.log(`[SSE] Auto-fetching tools from Chatmi...`);
    
    const toolsRequest = {
      method: 'tools/list',
      params: {},
      id: 'init-tools-list'
    };
    
    const inputString = JSON.stringify(toolsRequest);
    console.log(`[Chatmi] Requesting: ${inputString}`);

    const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'new_message',
        chat: { id: sessionId },
        text: inputString
      })
    });

    if (chatmiResponse.ok) {
      const chatmiData = await chatmiResponse.json();
      console.log(`[Chatmi] Response:`, JSON.stringify(chatmiData, null, 2));
      
      if (chatmiData.has_answer && chatmiData.messages.length > 0) {
        const outputString = chatmiData.messages[0].text;
        console.log(`[Chatmi] Output string: ${outputString}`);
        
        try {
          const result = JSON.parse(outputString);
          
          // Send tools list to n8n
          const toolsResponse = {
            jsonrpc: '2.0',
            id: 'init-tools-list',
            result: result
          };
          
          console.log(`[SSE] Sending tools:`, JSON.stringify(toolsResponse, null, 2));
          res.write(`data: ${JSON.stringify(toolsResponse)}\n\n`);
        } catch (parseError) {
          console.error(`[Chatmi] Parse error:`, parseError);
        }
      }
    } else {
      console.error(`[Chatmi] HTTP error: ${chatmiResponse.status}`);
    }
  } catch (error) {
    console.error(`[SSE] Error fetching tools:`, error);
  }

  // Keep-alive
  const keepAliveInterval = setInterval(() => {
    res.write(':ping\n\n');
  }, 30000);

  req.on('close', () => {
    console.log(`[SSE] Disconnected: ${sessionId}`);
    clearInterval(keepAliveInterval);
    connections.delete(sessionId);
  });
});

// Handle POST requests to /sse (for when n8n calls tools)
app.post('/sse', async (req, res) => {
  console.log(`========================================`);
  console.log(`[POST /sse] Request received`);
  console.log(`[POST /sse] Body:`, JSON.stringify(req.body, null, 2));
  
  const sessionId = req.query.session || req.headers['x-session-id'] || 'default';
  console.log(`[POST /sse] Session: ${sessionId}`);
  
  try {
    const mcpRequest = req.body;

    if (!mcpRequest || mcpRequest.jsonrpc !== '2.0' || !mcpRequest.method) {
      console.error(`[POST /sse] Invalid request format`);
      return res.status(400).json({
        jsonrpc: '2.0',
        id: mcpRequest?.id || null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    console.log(`[MCP] Method: ${mcpRequest.method}`);
    console.log(`[MCP] Params:`, mcpRequest.params);

    // Convert to Chatmi format
    const inputString = JSON.stringify({
      method: mcpRequest.method,
      params: mcpRequest.params || {},
      id: mcpRequest.id
    });

    console.log(`[Chatmi] Sending: ${inputString}`);

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
      throw new Error(`Chatmi HTTP ${chatmiResponse.status}`);
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
    } catch {
      result = outputString;
    }

    const mcpResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result
    };

    console.log(`[MCP] Response:`, JSON.stringify(mcpResponse, null, 2));

    // Try to send via SSE first
    if (connections.has(sessionId)) {
      console.log(`[MCP] Sending via SSE to session: ${sessionId}`);
      connections.get(sessionId).write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
      return res.status(202).json({ status: 'sent via SSE', sessionId });
    }

    // Fallback to direct HTTP response
    console.log(`[MCP] No SSE connection, sending via HTTP`);
    return res.json(mcpResponse);
    
  } catch (error) {
    console.error(`[Error]`, error);
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
    chatmi: CHATMI_ENDPOINT ? 'configured' : 'default'
  });
});

// Test Chatmi
app.post('/test/chatmi', async (req, res) => {
  try {
    console.log(`[Test] Testing Chatmi...`);
    
    const testPayload = {
      event: 'new_message',
      chat: { id: 'test' },
      text: JSON.stringify({
        method: 'tools/list',
        params: {},
        id: 1
      })
    };
    
    console.log(`[Test] Payload:`, testPayload);
    
    const response = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    
    console.log(`[Test] Status:`, response.status);
    
    const data = await response.json();
    console.log(`[Test] Response:`, data);
    
    res.json({ 
      success: true, 
      chatmiEndpoint: CHATMI_ENDPOINT,
      response: data 
    });
  } catch (error) {
    console.error(`[Test] Error:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      chatmiEndpoint: CHATMI_ENDPOINT
    });
  }
});

// Test what n8n sends
app.all('/debug', express.json(), (req, res) => {
  console.log('='.repeat(60));
  console.log('[DEBUG] Request received');
  console.log('[DEBUG] Method:', req.method);
  console.log('[DEBUG] URL:', req.url);
  console.log('[DEBUG] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[DEBUG] Body:', JSON.stringify(req.body, null, 2));
  console.log('='.repeat(60));
  
  res.json({
    received: {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body
    }
  });
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 MCP-Chatmi Server`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔌 SSE Endpoint: /sse`);
  console.log(`❤️  Health: /health`);
  console.log(`🧪 Test Chatmi: POST /test/chatmi`);
  console.log(`🐛 Debug: /debug`);
  console.log(`🔧 Chatmi: ${CHATMI_ENDPOINT}`);
  console.log('='.repeat(60));
});
