/**
 * index.js — LAN Games server entry point
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
 *   JWT_SECRET  Secret for signing JWTs  (REQUIRED — no default)
 *   JWT_EXPIRES Token lifetime          (default: 7d)
 *   NODE_ENV    Set to 'development' to suppress the LAN-binding warning
 */

'use strict';

// ── pre-flight checks ─────────────────────────────────────────────────────────
// These run before any module that depends on environment variables is required.

if (!process.env.JWT_SECRET) {
  console.error(`
[auth] FATAL: JWT_SECRET environment variable is not set.

  The server requires a secret key to sign and verify authentication tokens.
  There is no built-in default — a shared or predictable secret would allow
  tokens issued by any other instance to be accepted by this one.

  Generate a secure random secret (run this once and save the output):

    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

  Then start the server with the secret:

    JWT_SECRET=<paste-secret-here> npm start

  Or export it in your shell profile / process manager / .env file:

    export JWT_SECRET=<paste-secret-here>
    npm start
`);
  process.exit(1);
}

// ── imports ───────────────────────────────────────────────────────────────────

const gameRegistry = require('./game-registry');
const { createServer } = require('./app');

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

// ── build the server ──────────────────────────────────────────────────────────

const { httpServer, io } = createServer();

// ── start listening ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  const iface = HOST === '0.0.0.0' ? 'all interfaces' : HOST;
  console.log(`\n🎲  LAN Games server running on port ${PORT} (${iface})`);
  console.log(`   Open http://localhost:${PORT} in your browser`);
  console.log(`   LAN players can connect via http://<your-ip>:${PORT}\n`);

  if (HOST === '0.0.0.0' && process.env.NODE_ENV !== 'development') {
    console.warn(
      '  ⚠  WARNING: Server is bound to all network interfaces (0.0.0.0).\n' +
      '     This server is designed for trusted local networks only.\n' +
      '     Do NOT expose it to the public internet without:\n' +
      '       • HTTPS (TLS via a reverse proxy such as nginx or Caddy)\n' +
      '       • Rate limiting on auth endpoints\n' +
      '       • A firewall restricting inbound connections to LAN addresses\n' +
      '     To bind to localhost only:  HOST=127.0.0.1 npm start\n' +
      '     To suppress this warning:   NODE_ENV=development npm start\n'
    );
  }
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
