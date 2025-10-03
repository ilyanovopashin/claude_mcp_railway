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

  // Test different message formats to see what n8n accepts
  const testFormats = async () => {
    try {
      console.log(`[SSE] Testing different SSE message formats...`);
      
      // Format 1: Simple ping
      console.log(`[SSE FORMAT 1] Sending simple ping`);
      res.write(`:ping\n\n`);
      console.log(`[SSE FORMAT 1] ✓ Sent`);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Format 2: Named event
      console.log(`[SSE FORMAT 2] Sending named event`);
      res.write(`event: message\ndata: {"type":"test"}\n\n`);
      console.log(`[SSE FORMAT 2] ✓ Sent`);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Format 3: Just data
      console.log(`[SSE FORMAT 3] Sending just data`);
      res.write(`data: {"test": true}\n\n`);
      console.log(`[SSE FORMAT 3] ✓ Sent`);
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Now fetch and send actual tools
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

      console.log(`[Chatmi] Status: ${chatmiResponse.status}`);

      if (chatmiResponse.ok) {
        const chatmiData = await chatmiResponse.json();
        console.log(`[Chatmi] Response:`, JSON.stringify(chatmiData, null, 2));
        
        if (chatmiData.has_answer && chatmiData.messages.length > 0) {
          const outputString = chatmiData.messages[0].text;
          console.log(`[Chatmi] Output string: ${outputString}`);
          
          try {
            const result = JSON.parse(outputString);
            console.log(`[Chatmi] Parsed result:`, JSON.stringify(result, null, 2));
            
            // Try different response formats
            
            // Format A: Standard MCP response
            const formatA = {
              jsonrpc: '2.0',
              id: 'init-tools-list',
              result: result
            };
            console.log(`[SSE FORMAT A] Sending standard MCP response:`);
            console.log(JSON.stringify(formatA, null, 2));
            const messageA = `data: ${JSON.stringify(formatA)}\n\n`;
            console.log(`[SSE FORMAT A] Raw message: ${JSON.stringify(messageA)}`);
            res.write(messageA);
            console.log(`[SSE FORMAT A] ✓ Sent`);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Format B: Direct tools object
            console.log(`[SSE FORMAT B] Sending direct tools object:`);
            console.log(JSON.stringify(result, null, 2));
            const messageB = `data: ${JSON.stringify(result)}\n\n`;
            console.log(`[SSE FORMAT B] Raw message: ${JSON.stringify(messageB)}`);
            res.write(messageB);
            console.log(`[SSE FORMAT B] ✓ Sent`);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Format C: Named event with tools
            console.log(`[SSE FORMAT C] Sending as named event 'tools'`);
            const messageC = `event: tools\ndata: ${JSON.stringify(result)}\n\n`;
            console.log(`[SSE FORMAT C] Raw message: ${JSON.stringify(messageC)}`);
            res.write(messageC);
            console.log(`[SSE FORMAT C] ✓ Sent`);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Format D: Method notification format
            const formatD = {
              jsonrpc: '2.0',
              method: 'tools/list',
              params: result
            };
            console.log(`[SSE FORMAT D] Sending as method notification:`);
            console.log(JSON.stringify(formatD, null, 2));
            const messageD = `data: ${JSON.stringify(formatD)}\n\n`;
            console.log(`[SSE FORMAT D] Raw message: ${JSON.stringify(messageD)}`);
            res.write(messageD);
            console.log(`[SSE FORMAT D] ✓ Sent`);
            
            console.log(`[SSE] All formats sent. Check n8n to see which one works!`);
            
          } catch (parseError) {
            console.error(`[Chatmi] Parse error:`, parseError);
            console.error(`[Chatmi] Failed to parse: ${outputString}`);
          }
        } else {
          console.error(`[Chatmi] No answer or empty messages`);
        }
      } else {
        const errorText = await chatmiResponse.text();
        console.error(`[Chatmi] HTTP error ${chatmiResponse.status}: ${errorText}`);
      }
    } catch (error) {
      console.error(`[SSE] Error in testFormats:`, error);
      console.error(`[SSE] Error stack:`, error.stack);
    }
  };
  
  testFormats();

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
