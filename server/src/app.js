/**
 * app.js
 *
 * Builds and returns the Express + Socket.io server without starting it.
 * index.js calls createServer() and then calls httpServer.listen().
 * Integration tests call createServer() directly and bind to port 0 so the OS
 * picks a free ephemeral port.
 *
 * No process.exit() calls live here — startup pre-flight checks belong in
 * index.js only so that test code can require this module safely.
 */

'use strict';

const path    = require('path');
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const { Server: SocketIO } = require('socket.io');

const authRoutes    = require('./routes/auth.routes');
const gameRoutes    = require('./routes/game.routes');
const socketHandler = require('./socket-handler');
const gameRegistry  = require('./game-registry');

/**
 * Build the Express app and Socket.io server.
 * @returns {{ app, httpServer, io }}
 */
function createServer() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(cors({ origin: '*', credentials: true }));

  app.use('/api/auth',  authRoutes);
  app.use('/api/games', gameRoutes);

  app.get('/api/config', (req, res) => {
    try {
      res.json({ config: gameRegistry.getGameLogic('monopoly').getConfigCopy() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve static client files (no-op if the client directory doesn't exist,
  // which is the case during integration tests running from server/).
  const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');
  app.use(express.static(CLIENT_DIR));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });

  const httpServer = http.createServer(app);

  const io = new SocketIO(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout:  60_000,
    pingInterval: 25_000,
  });

  socketHandler.registerHandlers(io);

  return { app, httpServer, io };
}

module.exports = { createServer };
