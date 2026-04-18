/**
 * Monopoly Tracker — Backend Server
 * Run: node server.js
 * Requires: npm install express cors bcryptjs
 *
 * UPDATE: Added per-user isolated game instances.
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'monopoly_data.json');
const USERS_FILE = path.join(__dirname, 'monopoly_users.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── SSE clients ───────────────────────────────────────────────────────────────
// We now store the username along with the response object to isolate events
const sseClients = new Set();

function pushToUser(username, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    if (client.username === username) {
      try { client.res.write(msg); } catch(e) { sseClients.delete(client); }
    }
  });
}

// ─── File helpers ─────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) {}
  return fallback;
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const DEFAULT_STATE = {
  board: { name: 'My Monopoly Board', startMoney: 1500, bankBalance: 2000, goSalary: 200 },
  teams: [],
  properties: [],
  transactions: []
};

// We now store a map of game states keyed by username
let allGameStates = readJSON(DATA_FILE, {});
let users = readJSON(USERS_FILE, {});

// Migration logic: If the data file has the old global format, clear it to prevent crashes
if (allGameStates.board) {
  allGameStates = {};
  writeJSON(DATA_FILE, allGameStates);
}

// Helper to get or initialize a user's isolated state
function getUserState(username) {
  if (!allGameStates[username]) {
    allGameStates[username] = JSON.parse(JSON.stringify(DEFAULT_STATE));
    writeJSON(DATA_FILE, allGameStates);
  }
  return allGameStates[username];
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = {};

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { username, created: Date.now() };
  return token;
}
function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  return sessions[token] || null;
}
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.session = session; // Attach session so routes know WHO is calling
  next();
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (users[username]) return res.status(409).json({ error: 'Username already exists' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { hash, created: Date.now() };
  writeJSON(USERS_FILE, users);
  
  // Initialize their blank canvas game
  getUserState(username); 

  const token = createSession(username);
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = createSession(username);
  res.json({ token, username });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  delete sessions[token];
  res.json({ ok: true });
});

// ─── State routes ─────────────────────────────────────────────────────────────
app.get('/api/state', requireAuth, (req, res) => {
  res.json(getUserState(req.session.username));
});

app.post('/api/state', requireAuth, (req, res) => {
  const username = req.session.username;
  const newState = req.body;
  if (!newState || typeof newState !== 'object') return res.status(400).json({ error: 'Invalid state' });
  
  // Update ONLY the calling user's state
  allGameStates[username] = { ...DEFAULT_STATE, ...newState };
  writeJSON(DATA_FILE, allGameStates);
  pushToUser(username, 'stateUpdate', allGameStates[username]);
  res.json({ ok: true });
});

app.patch('/api/state', requireAuth, (req, res) => {
  const username = req.session.username;
  const patch = req.body;
  if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Invalid patch' });
  
  allGameStates[username] = deepMerge(getUserState(username), patch);
  writeJSON(DATA_FILE, allGameStates);
  pushToUser(username, 'stateUpdate', allGameStates[username]);
  res.json({ ok: true });
});

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (Array.isArray(source[key])) {
      result[key] = source[key];
    } else if (source[key] && typeof source[key] === 'object') {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ─── SSE endpoint ─────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  const queryToken = req.query.token;
  let session = null;
  
  if (queryToken && sessions[queryToken]) {
    session = sessions[queryToken];
  } else {
    session = getSession(req);
  }

  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const username = session.username;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  // Send initial data strictly for this user
  res.write(`event: stateUpdate\ndata: ${JSON.stringify(getUserState(username))}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  // Store the client mapped to their username
  const client = { res, username };
  sseClients.add(client);
  
  req.on('close', () => { 
    sseClients.delete(client); 
    clearInterval(heartbeat); 
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, clients: sseClients.size }));

app.listen(PORT, () => {
  console.log(`\n🎲 Monopoly Tracker running at http://localhost:${PORT}`);
  console.log(`   Data: ${DATA_FILE}`);
  console.log(`   Users: ${USERS_FILE}\n`);
});
