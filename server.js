const express = require('express');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://usernode.evanshapiro.dev" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WebSocket ---

const clients = new Map();
const USER_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
let colorCounter = 0;

function getUsers() {
  const seen = new Map();
  for (const [, info] of clients) {
    if (!seen.has(info.user.id)) {
      seen.set(info.user.id, { id: info.user.id, username: info.user.username, color: info.color });
    }
  }
  return Array.from(seen.values());
}

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== exclude && ws.readyState === 1) ws.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const token = url.searchParams.get('token');
  if (!token || !JWT_SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit('connection', ws);
    });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', async (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const color = USER_COLORS[colorCounter++ % USER_COLORS.length];
  clients.set(ws, { user: ws.user, color });

  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, points, color, size, tool FROM strokes ORDER BY created_at ASC'
    );
    sendTo(ws, { type: 'init', strokes: rows, users: getUsers(), you: { id: ws.user.id } });
  } catch {
    sendTo(ws, { type: 'init', strokes: [], users: getUsers(), you: { id: ws.user.id } });
  }

  broadcast({ type: 'users', users: getUsers() });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);
    if (!info) return;

    switch (msg.type) {
      case 'stroke': {
        try {
          const { rows } = await pool.query(
            'INSERT INTO strokes (user_id, username, points, color, size, tool) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [info.user.id, info.user.username, JSON.stringify(msg.points), msg.color, msg.size, msg.tool]
          );
          broadcast({
            type: 'stroke',
            stroke: {
              id: rows[0].id, user_id: info.user.id, username: info.user.username,
              points: msg.points, color: msg.color, size: msg.size, tool: msg.tool,
            }
          }, ws);
        } catch {}
        break;
      }
      case 'drawing': {
        broadcast({
          type: 'drawing', userId: info.user.id,
          points: msg.points, color: msg.color, size: msg.size, tool: msg.tool,
        }, ws);
        break;
      }
      case 'cursor': {
        broadcast({
          type: 'cursor', userId: info.user.id, username: info.user.username,
          x: msg.x, y: msg.y, color: info.color,
        }, ws);
        break;
      }
      case 'undo': {
        try {
          const { rows } = await pool.query(
            'DELETE FROM strokes WHERE id = (SELECT id FROM strokes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1) RETURNING id',
            [info.user.id]
          );
          if (rows.length > 0) {
            broadcast({ type: 'undo', strokeId: rows[0].id }, ws);
          }
        } catch {}
        break;
      }
      case 'clear': {
        try {
          await pool.query('DELETE FROM strokes');
          broadcast({ type: 'clear' }, ws);
        } catch {}
        break;
      }
    }
  });

  ws.on('close', () => {
    const userId = ws.user?.id;
    clients.delete(ws);
    broadcast({ type: 'users', users: getUsers() });
    if (userId != null) broadcast({ type: 'cursor_remove', userId });
  });
});

const heartbeat = setInterval(() => {
  for (const [ws] of clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strokes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      points JSONB NOT NULL,
      color VARCHAR(20) NOT NULL DEFAULT '#000000',
      size INTEGER NOT NULL DEFAULT 3,
      tool VARCHAR(20) NOT NULL DEFAULT 'pen',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  server.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
