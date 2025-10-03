require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');

function formatLog(level, scope, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const serializedMeta =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const base = `[${timestamp}] [${level}] [${scope}] ${message}${serializedMeta}`;

  switch (level) {
    case 'WARN':
      console.warn(base);
      break;
    case 'ERROR':
      console.error(base);
      break;
    case 'DEBUG':
      console.debug(base);
      break;
    default:
      console.log(base);
  }
}

function createLogger(scope, baseMeta = {}) {
  return {
    info(message, meta = {}) {
      formatLog('INFO', scope, message, { ...baseMeta, ...meta });
    },
    warn(message, meta = {}) {
      formatLog('WARN', scope, message, { ...baseMeta, ...meta });
    },
    error(message, meta = {}) {
      const errorMeta = meta instanceof Error ? { error: meta.stack } : meta;
      formatLog('ERROR', scope, message, { ...baseMeta, ...errorMeta });
    },
    debug(message, meta = {}) {
      formatLog('DEBUG', scope, message, { ...baseMeta, ...meta });
    }
  };
}

const rootLogger = createLogger('Server');

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    rootLogger.error('Unhandled promise rejection', reason);
  } else {
    rootLogger.error('Unhandled promise rejection', { reason });
  }
});

process.on('uncaughtException', (error) => {
  rootLogger.error('Uncaught exception', error);
});

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    rootLogger.warn('Received shutdown signal', { signal });
  });
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  const requestLogger = createLogger('HTTP', {
    requestId,
    method: req.method,
    url: req.originalUrl
  });

  req.log = requestLogger;
  res.locals.log = requestLogger;
  res.setHeader('x-request-id', requestId);

  const start = process.hrtime.bigint();
  requestLogger.info('Incoming request', {
    ip: req.ip,
    headers: req.headers,
    query: req.query
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    requestLogger.info('Request completed', {
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(3))
    });
  });

  req.on('error', (error) => {
    requestLogger.error('Request stream error', error);
  });

  res.on('error', (error) => {
    requestLogger.error('Response stream error', error);
  });

  next();
});

const CHATMI_ENDPOINT =
  process.env.CHATMI_ENDPOINT ||
  'https://admin.chatme.ai/connector/webim/webim_message/b453dc519e33a90c9ca6d3365445f3d3/bot_api_webhook';

const sseLogger = createLogger('SSE');
const mcpLogger = createLogger('MCP');
const debugLogger = createLogger('Debug');
const healthLogger = createLogger('Health');
const testLogger = createLogger('Test');

const connections = new Map();
let lastConnectedSessionId = null;
const MCP_PROTOCOL_VERSION = '2024-10-07';

async function sendChatmiRequest(
  sessionId,
  method,
  params = {},
  id = null,
  contextMeta = {}
) {
  const logger = createLogger('Chatmi', {
    sessionId,
    method,
    requestId: contextMeta.requestId,
    id
  });
  const chatmiPayload = {
    method,
    params,
    id
  };

  const inputString = JSON.stringify(chatmiPayload);
  logger.info('Sending request to Chatmi', { payload: chatmiPayload });

  const chatmiResponse = await fetch(CHATMI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'new_message',
      chat: { id: sessionId },
      text: inputString
    })
  });

  logger.info('Received HTTP response', { status: chatmiResponse.status });

  if (!chatmiResponse.ok) {
    const error = new Error(`Chatmi HTTP ${chatmiResponse.status}`);
    logger.error('Chatmi request failed', error);
    throw error;
  }

  const chatmiData = await chatmiResponse.json();
  logger.debug('Raw Chatmi response received', { response: chatmiData });

  if (!chatmiData.has_answer || chatmiData.messages.length === 0) {
    const error = new Error('No response from Chatmi');
    logger.error('Chatmi response missing answer', error);
    throw error;
  }

  const outputString = chatmiData.messages[0].text;
  logger.debug('Chatmi message text received', { outputString });

  let result;
  try {
    result = JSON.parse(outputString);
  } catch {
    result = outputString;
  }

  logger.info('Chatmi request completed', { resultType: typeof result });

  return result;
}

function describeConnection(connection) {
  return `writableEnded=${connection.writableEnded} writableFinished=${connection.writableFinished}`;
}

function logConnectionSnapshot() {
  sseLogger.debug('Connection snapshot', {
    totalConnections: connections.size,
    sessions: Array.from(connections.keys())
  });
  for (const [session, connection] of connections.entries()) {
    sseLogger.debug('Session connection state', {
      session,
      state: describeConnection(connection)
    });
  }
}

function writeSsePayload(sessionId, payloadEnvelope, context = {}) {
  logConnectionSnapshot();
  const payload = JSON.stringify(payloadEnvelope);

  const writeToConnection = (targetSessionId, connection) => {
    mcpLogger.debug('Writing payload to connection', {
      targetSessionId,
      connectionState: describeConnection(connection),
      payload: payloadEnvelope,
      requestMethod: context.requestMethod,
      responseId: context.responseId,
      deliveryReason: context.deliveryReason
    });
    if (!connection.writableEnded && !connection.writableFinished && !connection.destroyed) {
      connection.write(`data: ${payload}\n\n`);
    } else {
      mcpLogger.warn('Skipped connection because it is not writable', {
        targetSessionId,
        requestMethod: context.requestMethod,
        deliveryReason: context.deliveryReason
      });
    }
  };

  if (sessionId && connections.has(sessionId)) {
    writeToConnection(sessionId, connections.get(sessionId));
  } else if (connections.size === 1) {
    const [onlySessionId, onlyConnection] = connections.entries().next().value;
    mcpLogger.warn('Original session not found; broadcasting to single connection', {
      requestedSession: sessionId,
      fallbackSession: onlySessionId,
      requestMethod: context.requestMethod,
      deliveryReason: context.deliveryReason
    });
    writeToConnection(onlySessionId, onlyConnection);
  } else if (connections.size > 1) {
    mcpLogger.warn('Original session not found; broadcasting to all connections', {
      requestedSession: sessionId,
      activeConnections: connections.size,
      requestMethod: context.requestMethod,
      deliveryReason: context.deliveryReason
    });
    for (const [connectedSessionId, connection] of connections.entries()) {
      writeToConnection(connectedSessionId, connection);
    }
  } else {
    mcpLogger.warn('No SSE connection available for response delivery', {
      requestedSession: sessionId,
      requestMethod: context.requestMethod,
      deliveryReason: context.deliveryReason
    });
  }
}

function deliverMcpResponse(sessionId, response, res, context = {}, statusCode = 200) {
  const payloadEnvelope = {
    type: 'response',
    response
  };
  mcpLogger.info('Delivering MCP response', {
    sessionId,
    responseId: response.id,
    requestMethod: context.requestMethod
  });
  mcpLogger.debug('Prepared SSE payload envelope', {
    sessionId,
    responseId: response.id,
    requestMethod: context.requestMethod,
    payload: payloadEnvelope
  });
  writeSsePayload(sessionId, payloadEnvelope, {
    requestMethod: context.requestMethod,
    responseId: response.id
  });

  mcpLogger.info('Responding to HTTP POST /sse', {
    sessionId,
    responseId: response.id,
    requestMethod: context.requestMethod
  });
  return res.status(statusCode).json(response);
}

app.use(cors());
app.use(
  express.json({
    limit: '1mb',
    verify(req, res, buf) {
      req.rawBody = buf.toString();
    }
  })
);

app.use((req, res, next) => {
  if (req.log && req.body && Object.keys(req.body).length > 0) {
    req.log.debug('Parsed JSON body', { body: req.body });
  } else if (req.log && req.rawBody) {
    req.log.debug('Received raw body', { body: req.rawBody });
  }
  next();
});

// Main SSE endpoint
app.get('/sse', async (req, res) => {
  const sessionId = req.query.session || `session-${Date.now()}`;
  const logger = req.log || sseLogger;

  logger.info('SSE connection established', {
    sessionId,
    timestamp: new Date().toISOString()
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  connections.set(sessionId, res);
  lastConnectedSessionId = sessionId;
  logger.info('SSE connection stored', {
    activeConnections: connections.size
  });
  logConnectionSnapshot();

  writeSsePayload(
    sessionId,
    {
      type: 'session',
      session: {
        id: sessionId,
        protocol: 'MCP',
        protocolVersion: MCP_PROTOCOL_VERSION
      }
    },
    {
      requestMethod: 'session-start',
      deliveryReason: 'sse-handshake'
    }
  );

  // Keep-alive
  const keepAliveInterval = setInterval(() => {
    res.write(':ping\n\n');
    logger.debug('Sent SSE keep-alive ping', { sessionId });
  }, 30000);

  req.on('error', (error) => {
    logger.error('SSE request stream error', error);
  });

  res.on('error', (error) => {
    logger.error('SSE response stream error', error);
  });

  req.on('close', () => {
    logger.info('SSE connection closed', { sessionId });
    clearInterval(keepAliveInterval);
    connections.delete(sessionId);
    if (lastConnectedSessionId === sessionId) {
      const next = connections.keys().next().value;
      lastConnectedSessionId = next ?? null;
    }
    logConnectionSnapshot();
  });
});

// Handle POST requests to /sse (for when n8n calls tools)
app.post('/sse', async (req, res) => {
  const logger = req.log || mcpLogger;
  logger.info('Handling MCP HTTP request');

  let sessionId = req.query.session || req.headers['x-session-id'];
  if (!sessionId && connections.size === 1) {
    sessionId = connections.keys().next().value;
    logger.info('Falling back to single active session', { sessionId });
  }
  if (!sessionId) {
    sessionId = lastConnectedSessionId || 'default';
    logger.info('Using last connected session as fallback', { sessionId });
  }

  logger.info('Resolved session for MCP request', { sessionId });

  try {
    const mcpRequest = req.body;

    if (!mcpRequest || mcpRequest.jsonrpc !== '2.0' || !mcpRequest.method) {
      logger.error('Invalid MCP request format', { body: req.body });
      return res.status(400).json({
        jsonrpc: '2.0',
        id: mcpRequest?.id || null,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }

    logger.info('Processing MCP request', {
      method: mcpRequest.method,
      params: mcpRequest.params
    });

    const result = await sendChatmiRequest(
      sessionId,
      mcpRequest.method,
      mcpRequest.params || {},
      mcpRequest.id,
      { requestId: req.headers['x-request-id'] }
    );

    const mcpResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result
    };

    logger.debug('Generated MCP response', {
      response: mcpResponse,
      requestMethod: mcpRequest.method
    });

    return deliverMcpResponse(sessionId, mcpResponse, res, {
      requestMethod: mcpRequest.method
    });

  } catch (error) {
    logger.error('Failed to process MCP request', error);
    const errorResponse = {
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    };

    return deliverMcpResponse(
      sessionId,
      errorResponse,
      res,
      { requestMethod: req.body?.method },
      500
    );
  }
});

app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    connections: connections.size,
    sessions: Array.from(connections.keys()),
    chatmi: CHATMI_ENDPOINT ? 'configured' : 'default'
  };
  (req.log || healthLogger).info('Health check requested', health);
  res.json(health);
});

// Test Chatmi
app.post('/test/chatmi', async (req, res) => {
  try {
    const logger = req.log || testLogger;
    logger.info('Testing Chatmi endpoint');

    const testPayload = {
      event: 'new_message',
      chat: { id: 'test' },
      text: JSON.stringify({
        method: 'tools/list',
        params: {},
        id: 1
      })
    };

    logger.debug('Prepared test payload', testPayload);

    const response = await fetch(CHATMI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });

    logger.info('Received Chatmi test response status', { status: response.status });

    const data = await response.json();
    logger.debug('Received Chatmi test response body', data);

    res.json({
      success: true,
      chatmiEndpoint: CHATMI_ENDPOINT,
      response: data
    });
  } catch (error) {
    (req.log || testLogger).error('Test Chatmi endpoint failed', error);
    res.status(500).json({
      success: false,
      error: error.message,
      chatmiEndpoint: CHATMI_ENDPOINT
    });
  }
});

// Test what n8n sends
app.all('/debug', (req, res) => {
  const logger = req.log || debugLogger;
  logger.info('Debug endpoint invoked', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body
  });

  res.json({
    received: {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body
    }
  });
});

app.use((err, req, res, next) => {
  const logger = req?.log || rootLogger;
  logger.error('Unhandled application error', err);
  res.status(500).json({
    error: {
      message: err.message || 'Internal Server Error'
    }
  });
});

app.listen(PORT, () => {
  rootLogger.info('Server started', {
    port: PORT,
    sseEndpoint: '/sse',
    healthEndpoint: '/health',
    testEndpoint: '/test/chatmi',
    debugEndpoint: '/debug',
    chatmiEndpoint: CHATMI_ENDPOINT
  });
});
