/**
 * index.js — Monopoly Server entry point
 *
 * Starts an Express HTTP server combined with a Socket.io WebSocket server.
 * The client (served from ../client) connects to both:
 *   - REST endpoints under /api  for auth and game management
 *   - Socket.io on /              for real-time game events
 *
 * Environment variables
 * ─────────────────────
 *   PORT        TCP port to listen on (default: 3000)
 *   HOST        Bind address (default: 0.0.0.0 — all interfaces)
 *   JWT_SECRET  Secret for signing JWTs  (CHANGE THIS in production!)
 *   JWT_EXPIRES Token lifetime          (default: 7d)
 */

'use strict';

const path   = require('path');
const http   = require('http');
const express = require('express');
const cors    = require('cors');
const { Server: SocketIO } = require('socket.io');

const authRoutes      = require('./routes/auth.routes');
const gameRoutes      = require('./routes/game.routes');
const socketHandler   = require('./socket-handler');
const gameRegistry    = require('./game-registry');

// ── validate all registered game configs on startup ──────────────────────────

try {
  for (const key of gameRegistry.listGameTypes()) {
    gameRegistry.getGameLogic(key).loadConfig();
  }
  console.log('[config] All game configs loaded successfully');
} catch (err) {
  console.error('[config] FATAL — invalid config files:', err.message);
  process.exit(1);
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Parse JSON bodies
app.use(express.json({ limit: '1mb' }));

// CORS: allow all origins on LAN (tighten this for public deployments)
app.use(cors({ origin: '*', credentials: true }));

// ── REST routes ──────────────────────────────────────────────────────────────

app.use('/api/auth',  authRoutes);
app.use('/api/games', gameRoutes);

// Config endpoint (convenience alias — monopoly default config)
app.get('/api/config', (req, res) => {
  try {
    res.json({ config: gameRegistry.getGameLogic('monopoly').getConfigCopy() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve static client files ────────────────────────────────────────────────

const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');
app.use(express.static(CLIENT_DIR));

// Single-page application fallback — any unmatched GET returns index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// ── HTTP + Socket.io server ──────────────────────────────────────────────────

const httpServer = http.createServer(app);

const io = new SocketIO(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Increase the ping timeout so LAN players on slow links don't get dropped
  pingTimeout:  60000,
  pingInterval: 25000,
});

socketHandler.registerHandlers(io);

// ── start listening ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  const iface = HOST === '0.0.0.0' ? 'all interfaces' : HOST;
  console.log(`\n🎲  Monopoly Server running on port ${PORT} (${iface})`);
  console.log(`   Open http://localhost:${PORT} in your browser`);
  console.log(`   LAN players can connect via http://<your-ip>:${PORT}\n`);
});

// ── graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[server] Shutting down gracefully...');
  // Close Socket.io first so active WebSocket connections don't keep the
  // HTTP server alive indefinitely.
  io.close(() => {
    httpServer.close(() => {
      console.log('[server] HTTP server closed.');
      process.exit(0);
    });
  });
  // Force-exit after 3 s in case a connection refuses to close cleanly.
  setTimeout(() => {
    console.log('[server] Forced exit after timeout.');
    process.exit(0);
  }, 3000).unref();
});
