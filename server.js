require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://admin.chatme.ai/connector/webim/webim_message/a7e28b914256ab13395ec974e7bb9548/bot_api_webhook';

const connections = new Map();

app.use(cors());
app.use(express.json());

// SSE endpoint
app.get('/sse', (req, res) => {
  const sessionId = req.query.session || `session-${Date.now()}`;
  
  console.log(`[SSE Connected] Session: ${sessionId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`data: ${JSON.stringify({
    type: 'connection',
    sessionId,
    timestamp: new Date().toISOString()
  })}\n\n`);

  connections.set(sessionId, res);

  const keepAliveInterval = setInterval(() => {
    res.write(':ping\n\n');
  }, 30000);

  req.on('close', () => {
    console.log(`[SSE Disconnected] Session: ${sessionId}`);
    clearInterval(keepAliveInterval);
    connections.delete(sessionId);
  });
});

// Message endpoint
app.post('/message', async (req, res) => {
  try {
    const mcpRequest = req.body;
    const sessionId = req.query.session || req.headers['x-session-id'];

    console.log('[MCP Request]', JSON.stringify(mcpRequest));

    if (mcpRequest.jsonrpc !== '2.0' || !mcpRequest.method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: mcpRequest.id || null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    const inputString = JSON.stringify({
      method: mcpRequest.method,
      params: mcpRequest.params || {},
      id: mcpRequest.id
    });

    console.log('[Chatmi Input]', inputString);

    const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'new_message',
        chat: { id: sessionId || 'mcp-session' },
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

    if (sessionId && connections.has(sessionId)) {
      const sseConnection = connections.get(sessionId);
      sseConnection.write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
      return res.status(202).json({ status: 'sent via SSE' });
    }

    return res.status(200).json(mcpResponse);
    
  } catch (error) {
    console.error('[Error]', error);
    return res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: { code: -32603, message: error.message }
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connections: connections.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
