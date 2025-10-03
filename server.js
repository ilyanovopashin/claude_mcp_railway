require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const CHATMI_ENDPOINT = process.env.CHATMI_ENDPOINT || 
  'https://admin.chatme.ai/connector/webim/webim_message/b453dc519e33a90c9ca6d3365445f3d3/bot_api_webhook';

const connections = new Map();

const toolsListCache = {
  data: null,
  timestamp: 0
};

const TOOLS_LIST_CACHE_TTL = 60 * 1000; // 1 minute cache TTL for tools list

function isToolsListCacheValid() {
  return (
    toolsListCache.data !== null &&
    Date.now() - toolsListCache.timestamp < TOOLS_LIST_CACHE_TTL
  );
}

async function sendChatmiRequest(sessionId, method, params = {}, id = null) {
  const chatmiPayload = {
    method,
    params,
    id
  };

  const inputString = JSON.stringify(chatmiPayload);
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

  return result;
}

async function warmToolsList(sessionId) {
  try {
    console.log(`[Warmup] Refreshing tools list cache...`);
    const result = await sendChatmiRequest(sessionId, 'tools/list', {}, 'warm-tools-list');
    toolsListCache.data = result;
    toolsListCache.timestamp = Date.now();
    console.log(`[Warmup] Tools list cache updated`);
  } catch (error) {
    console.error(`[Warmup] Failed to refresh tools list cache:`, error);
  }
}

function deliverMcpResponse(sessionId, response, res) {

  const payload = JSON.stringify(response);

  if (connections.has(sessionId)) {
    console.log(`[MCP] Sending via SSE to session: ${sessionId}`);
    connections.get(sessionId).write(`data: ${payload}\n\n`);
  } else {
    console.log(`[MCP] No SSE connection found for session: ${sessionId}`);
  }

  return res.status(200).json(response);

}

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
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  connections.set(sessionId, res);
  console.log(`[SSE] Active connections: ${connections.size}`);

  if (!isToolsListCacheValid()) {
    warmToolsList(sessionId);
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
    if (mcpRequest.method === 'tools/list' && isToolsListCacheValid()) {
      console.log(`[MCP] Serving tools list from cache`);
      const cachedResponse = {
        jsonrpc: '2.0',
        id: mcpRequest.id,
        result: toolsListCache.data
      };

      const delivery = deliverMcpResponse(sessionId, cachedResponse, res);
      warmToolsList(sessionId);
      return delivery;
    }


    const result = await sendChatmiRequest(
      sessionId,
      mcpRequest.method,
      mcpRequest.params || {},
      mcpRequest.id
    );


    if (mcpRequest.method === 'tools/list') {
      toolsListCache.data = result;
      toolsListCache.timestamp = Date.now();
      console.log(`[MCP] Tools list cache updated`);
    }

    const mcpResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result
    };

    console.log(`[MCP] Response:`, JSON.stringify(mcpResponse, null, 2));

    return deliverMcpResponse(sessionId, mcpResponse, res);

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
