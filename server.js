const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and body parsers
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log every request (method, path, status) to console
app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode}`);
  });
  next();
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data storage
// tokens: Map<string, { expiresAt: number | null }>
const tokens = new Map();

// sessions: Map<string, Session>
const sessions = new Map();
const cleanupTimers = new Map();

// Schedule session deletion 5 minutes after disconnect
function scheduleSessionCleanup(sessionId) {
  if (cleanupTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    sessions.delete(sessionId);
    cleanupTimers.delete(sessionId);
    console.log(`[Cleanup] Session ${sessionId} removed after 5 minutes.`);
  }, 5 * 60 * 1000);
  cleanupTimers.set(sessionId, timer);
}

// ----------------------------------------------------
// AUTH ENDPOINTS
// POST /webinteractionsdk/oauth2/token & POST /oauth/token
// ----------------------------------------------------
function handleTokenRequest(req, res) {
  console.log('[TOKEN DEBUG]', JSON.stringify({
    auth: req.headers['authorization'],
    contentType: req.headers['content-type'],
    body: req.body,
    query: req.query,
    decoded: (() => { try { return Buffer.from(String(req.headers['authorization'] || '').slice(6).trim(), 'base64').toString('utf8'); } catch (e) { return 'ERR'; } })()
  }));

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    return res.status(401).end();
  }

  const base64Creds = authHeader.slice(6).trim();
  let decoded = '';
  try {
    decoded = Buffer.from(base64Creds, 'base64').toString('utf8');
  } catch (err) {
    return res.status(401).end();
  }

  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    return res.status(401).end();
  }

  const clientId = decoded.slice(0, colonIdx);
  const clientSecret = decoded.slice(colonIdx + 1);

  const expectedClientId = process.env.CLIENT_ID || 'mockclient';
  const expectedClientSecret = process.env.CLIENT_SECRET || 'mocksecret';

  const grantType = req.body?.grant_type;

  if (clientId !== expectedClientId || clientSecret !== expectedClientSecret || grantType !== 'client_credentials') {
    return res.status(401).end();
  }

  const accessToken = crypto.randomUUID();
  const validitySeconds = parseInt(process.env.TOKEN_VALIDITY_SECONDS ?? '3600', 10);
  const expiresAt = validitySeconds === 0 ? null : Date.now() + validitySeconds * 1000;

  tokens.set(accessToken, { expiresAt });

  return res.status(200).json({
    access_token: accessToken,
    token_type: 'bearer',
    scope: 'all'
  });
}

app.post(['/webinteractionsdk/oauth2/token', '/oauth/token'], handleTokenRequest);

// ----------------------------------------------------
// BEARER AUTH MIDDLEWARE FOR /v1/* & /webinteractionsdk/v1/*
// ----------------------------------------------------
function bearerAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).end();
  }

  const token = authHeader.slice(7).trim();
  const tokenData = tokens.get(token);

  if (!tokenData) {
    return res.status(401).end();
  }

  if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
    tokens.delete(token);
    return res.status(401).end();
  }

  next();
}

// ----------------------------------------------------
// SESSION API ROUTER
// ----------------------------------------------------
const v1Router = express.Router();
v1Router.use(bearerAuthMiddleware);

// POST /v1/sessions
v1Router.post('/sessions', (req, res) => {
  const {
    businessUnitName,
    caption,
    customerName,
    language,
    priority,
    source,
    destination,
    contactData
  } = req.body || {};

  // Validate required fields
  const isValidPriority = Number.isInteger(priority) && priority >= 1 && priority <= 100;
  if (!businessUnitName || !caption || !customerName || !language || !isValidPriority || !source) {
    return res.status(400).end();
  }

  // Create session ID: "W" + 50 random hex chars
  const sessionId = 'W' + crypto.randomBytes(25).toString('hex');

  const initialContents = [
    {
      messageType: 'CUSTOMER_MESSAGE',
      from: customerName,
      agentFirstName: '',
      agentLastName: '',
      content: caption,
      formattedContent: caption,
      pushedUrl: ''
    }
  ];

  const session = {
    id: sessionId,
    businessUnitName,
    caption,
    customerName,
    language,
    priority,
    source,
    destination: destination || '',
    contactData: Array.isArray(contactData) ? contactData : [],
    connected: true,
    contents: initialContents,
    createdAt: Date.now(),
    customerTypingUntil: 0,
    agentTypingUntil: 0,
    agentTypingName: ''
  };

  sessions.set(sessionId, session);

  return res.status(201).json({ sessionId });
});

// GET /v1/sessions/:sessionId/contents & /v1/sessions/:sessionId/contents/:indexKey
function handleGetContents(req, res) {
  const { sessionId, indexKey } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).end();
  }

  let whoIsTyping = '';
  if (session.agentTypingUntil && Date.now() < session.agentTypingUntil) {
    whoIsTyping = session.agentTypingName || 'Agent';
  }

  const parsedIndex = indexKey !== undefined ? parseInt(indexKey, 10) : 0;
  let contentSlice = [];
  let newIndexKey = 1;

  if (isNaN(parsedIndex) || parsedIndex <= 0) {
    // indexKey 0 = all contents
    contentSlice = session.contents;
    newIndexKey = session.contents.length + 1;
  } else {
    const startIndex = parsedIndex - 1; // 1-based, inclusive
    if (startIndex < session.contents.length) {
      contentSlice = session.contents.slice(startIndex);
      newIndexKey = session.contents.length + 1;
    } else {
      // No new content
      contentSlice = [];
      newIndexKey = parsedIndex;
    }
  }

  return res.status(200).json({
    sessionId: session.id,
    content: contentSlice,
    pushUrl: '',
    callMeAgentKey: 0,
    newIndexKey: newIndexKey,
    whoIsTyping: whoIsTyping,
    redirectUrl: '',
    connected: Boolean(session.connected)
  });
}

v1Router.get('/sessions/:sessionId/contents', handleGetContents);
v1Router.get('/sessions/:sessionId/contents/:indexKey', handleGetContents);

// POST /v1/sessions/:sessionId/contents
v1Router.post('/sessions/:sessionId/contents', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).end();
  }

  if (!session.connected) {
    return res.status(503).end();
  }

  const content = req.body?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).end();
  }

  session.contents.push({
    messageType: 'CUSTOMER_MESSAGE',
    from: session.customerName,
    agentFirstName: '',
    agentLastName: '',
    content: content,
    formattedContent: content,
    pushedUrl: ''
  });

  session.customerTypingUntil = 0;
  return res.status(201).end();
});

// POST /v1/sessions/:sessionId/typing
v1Router.post('/sessions/:sessionId/typing', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).end();
  }

  const isTyping = req.body?.isTyping === true || req.body?.isTyping === 'true';
  if (isTyping) {
    session.customerTypingUntil = Date.now() + 5000;
  } else {
    session.customerTypingUntil = 0;
  }

  return res.status(200).end();
});

// DELETE /v1/sessions/:sessionId & DELETE /v1/sessions
function handleDeleteSession(req, res) {
  const sessionId = req.params.sessionId || req.body?.sessionId;
  if (!sessionId) {
    return res.status(400).end();
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).end();
  }

  if (session.connected) {
    session.connected = false;
    session.contents.push({
      messageType: 'CUSTOMER_DISCONNECT',
      from: session.customerName,
      agentFirstName: '',
      agentLastName: '',
      content: 'Customer disconnected',
      formattedContent: 'Customer disconnected',
      pushedUrl: ''
    });
    scheduleSessionCleanup(sessionId);
  }

  return res.status(200).end();
}

v1Router.delete('/sessions/:sessionId', handleDeleteSession);
v1Router.delete('/sessions', handleDeleteSession);

// Mount /v1 and /webinteractionsdk/v1
app.use('/v1', v1Router);
app.use('/webinteractionsdk/v1', v1Router);

// ----------------------------------------------------
// MOCK-ONLY AGENT SIDE (no auth, prefix /mock)
// ----------------------------------------------------
const mockRouter = express.Router();

// GET /mock/sessions
mockRouter.get('/sessions', (req, res) => {
  const list = [];
  for (const session of sessions.values()) {
    const lastMsg = session.contents.length > 0 ? session.contents[session.contents.length - 1].content : '';
    list.push({
      id: session.id,
      customerName: session.customerName,
      caption: session.caption,
      lastMessage: lastMsg,
      connected: session.connected,
      createdAt: session.createdAt
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// GET /mock/sessions/:id/contents
mockRouter.get('/sessions/:id/contents', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const customerTyping = Boolean(session.customerTypingUntil && Date.now() < session.customerTypingUntil);

  return res.json({
    id: session.id,
    customerName: session.customerName,
    connected: session.connected,
    customerTyping: customerTyping,
    contents: session.contents
  });
});

// POST /mock/sessions/:id/agent-message
mockRouter.post('/sessions/:id/agent-message', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { text, agentKey = '14', firstName = 'Agent', lastName = 'One' } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  session.contents.push({
    messageType: 'AGENT_MESSAGE',
    from: String(agentKey),
    agentFirstName: firstName,
    agentLastName: lastName,
    content: `<p style="margin: 0">${text}</p>`,
    formattedContent: `<table><tr><td>${text}</td></tr></table>`,
    pushedUrl: ''
  });

  session.agentTypingUntil = 0;
  session.agentTypingName = '';
  return res.status(200).json({ success: true });
});

// POST /mock/sessions/:id/agent-typing
mockRouter.post('/sessions/:id/agent-typing', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const isTyping = req.body?.isTyping === true || req.body?.isTyping === 'true';
  if (isTyping) {
    const firstName = req.body?.firstName || 'Agent';
    const lastName = req.body?.lastName || 'One';
    session.agentTypingUntil = Date.now() + 4000;
    session.agentTypingName = `${firstName} ${lastName}`.trim();
  } else {
    session.agentTypingUntil = 0;
    session.agentTypingName = '';
  }

  return res.status(200).json({ success: true });
});

// POST /mock/sessions/:id/agent-connect
mockRouter.post('/sessions/:id/agent-connect', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.agentConnected) {
    session.agentConnected = true;
    const agentName = req.body?.agentName || 'Srini Agent';
    session.contents.push({
      messageType: 'SYSTEM_MESSAGE',
      from: 'System',
      agentFirstName: req.body?.firstName || 'Srini',
      agentLastName: req.body?.lastName || '',
      content: `${agentName} has Connected.`,
      formattedContent: `<p>${agentName} has Connected.</p>`,
      pushedUrl: '',
      timestamp: Date.now()
    });
    console.log(`[Agent Connect] ${agentName} connected to session ${session.id}`);
    return res.status(200).json({ success: true, connected: true });
  }

  return res.status(200).json({ success: true, alreadyConnected: true });
});

// POST /mock/sessions/:id/agent-push-url
mockRouter.post('/sessions/:id/agent-push-url', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { url, agentKey = '14', firstName = 'Srini', lastName = 'Agent' } = req.body || {};
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let formattedUrl = url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'https://' + formattedUrl;
  }

  session.contents.push({
    messageType: 'AGENT_PUSH_URL',
    from: String(agentKey),
    agentFirstName: firstName,
    agentLastName: lastName,
    content: formattedUrl,
    formattedContent: `<a href="${formattedUrl}" target="_blank">${formattedUrl}</a>`,
    pushedUrl: formattedUrl,
    timestamp: Date.now()
  });

  console.log(`[Agent Push URL] Pushed ${formattedUrl} to session ${session.id}`);
  return res.status(200).json({ success: true, pushedUrl: formattedUrl });
});

// POST /mock/sessions/:id/agent-disconnect
mockRouter.post('/sessions/:id/agent-disconnect', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.connected) {
    session.connected = false;
    session.contents.push({
      messageType: 'AGENT_DISCONNECT',
      from: 'System',
      agentFirstName: '',
      agentLastName: '',
      content: 'Agent disconnected',
      formattedContent: 'Agent disconnected',
      pushedUrl: ''
    });
    scheduleSessionCleanup(session.id);
  }

  return res.status(200).json({ success: true });
});

app.use('/mock', mockRouter);

// Start server
app.listen(PORT, () => {
  console.log(`OSCC Mock Service running on port ${PORT}`);
});
