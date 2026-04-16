/**
 * Monopoly Tracker — Backend Server
 * Run: node server.js
 * Requires: npm install express cors bcryptjs
 *
 * Supports features (all handled via generic state persistence):
 *  - Mortgage / Unmortgage: property.mortgaged flag, 50% value credited to player
 *  - Auction: bank auction for unowned/bankrupted properties
 *  - Bankruptcy to bank: properties returned to bank, player removed, then auctioned
 *  - Transaction types: rent, credit, debit, mortgage, unmortgage, auction, bankruptcy
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
app.use(express.static(__dirname)); // serves index.html

// ─── SSE clients for real-time push ───────────────────────────────────────────
const sseClients = new Set();

function pushToAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch(e) { sseClients.delete(res); }
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

// ─── Initial data ─────────────────────────────────────────────────────────────
const DEFAULT_STATE = {
  board: { name: 'My Monopoly Board', startMoney: 1500 },
  teams: [],
  properties: [],
  transactions: []
};

let gameState = readJSON(DATA_FILE, DEFAULT_STATE);
let users = readJSON(USERS_FILE, {});

// ─── Sessions (in-memory, simple token map) ───────────────────────────────────
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
  if (!getSession(req)) return res.status(401).json({ error: 'Unauthorized' });
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
  res.json(gameState);
});

app.post('/api/state', requireAuth, (req, res) => {
  const newState = req.body;
  if (!newState || typeof newState !== 'object') return res.status(400).json({ error: 'Invalid state' });
  gameState = { ...DEFAULT_STATE, ...newState };
  writeJSON(DATA_FILE, gameState);
  pushToAll('stateUpdate', gameState);
  res.json({ ok: true });
});

// Granular patch endpoint (more efficient)
app.patch('/api/state', requireAuth, (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'Invalid patch' });
  gameState = deepMerge(gameState, patch);
  writeJSON(DATA_FILE, gameState);
  pushToAll('stateUpdate', gameState);
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
// EventSource can't set headers, so we accept token via query param too
app.get('/api/events', (req, res) => {
  // Check Authorization header OR ?token= query param
  const queryToken = req.query.token;
  if (queryToken && !sessions[queryToken]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!queryToken) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // for nginx
  res.flushHeaders();

  // Send current state immediately on connect
  res.write(`event: stateUpdate\ndata: ${JSON.stringify(gameState)}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, clients: sseClients.size }));

app.listen(PORT, () => {
  console.log(`\n🎲 Monopoly Tracker running at http://localhost:${PORT}`);
  console.log(`   Data stored in: ${DATA_FILE}`);
  console.log(`   Users stored in: ${USERS_FILE}\n`);
});
