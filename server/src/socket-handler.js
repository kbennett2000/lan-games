/**
 * socket-handler.js
 *
 * Wires all Socket.io real-time events for game play.
 *
 * Connection lifecycle
 * ────────────────────
 *   connect        → client authenticates via socket.handshake.auth.token
 *   join_game      → client joins a Socket.io room for a specific game
 *   leave_game     → client leaves the room (but stays in DB)
 *   disconnect     → mark player as disconnected; game continues
 *
 * In-game events (client → server)
 * ──────────────────────────────────
 *   game:start         host starts the game
 *   turn:rollDice
 *   turn:buyProperty
 *   turn:declinePurchase
 *   turn:auction:bid   { amount }
 *   turn:auction:pass
 *   turn:buildHouse    { position }
 *   turn:sellHouse     { position }
 *   turn:mortgage      { position }
 *   turn:unmortgage    { position }
 *   turn:payJailFine
 *   turn:useJailCard
 *   turn:endTurn
 *   trade:offer        { toUserId, offerMoney, offerProps, offerCards, requestMoney, requestProps, requestCards }
 *   trade:accept
 *   trade:reject
 *   trade:cancel
 *   game:save
 *   chat:message       { text }
 *
 * Server → client broadcasts (to the game room)
 * ───────────────────────────────────────────────
 *   game:state         full GameState (on join)
 *   game:update        { state, events[] }  after every action
 *   game:error         { message }  (to the acting socket only)
 *   chat:message       { username, text, timestamp }
 */

'use strict';

const { authenticateSocket } = require('./auth');
const gameManager             = require('./game-manager');
const database                = require('./database');

// Track which socket is in which game room: Map<socketId, gameId>
const socketGameMap = new Map();

// Stored io reference so REST routes can trigger lobby broadcasts
let _io = null;

/**
 * Emit 'lobby:update' to all connected sockets so every client on the lobby
 * screen refreshes its game list automatically.
 */
function broadcastLobbyUpdate() {
  if (_io) _io.emit('lobby:update');
}

/**
 * Register all Socket.io event handlers.
 * @param {import('socket.io').Server} io
 */
function registerHandlers(io) {
  _io = io;

  io.on('connection', (socket) => {

    // ── authenticate ────────────────────────────────────────────────────────

    let currentUser = null;
    try {
      currentUser = authenticateSocket(socket);
    } catch {
      socket.emit('auth:error', { message: 'Invalid or missing token. Please log in again.' });
      socket.disconnect(true);
      return;
    }

    console.log(`[socket] ${currentUser.username} connected (${socket.id})`);

    // ── join game room ───────────────────────────────────────────────────────

    socket.on('join_game', (gameId, ack) => {
      const state = gameManager.getGame(gameId);
      if (!state) {
        return ack?.({ error: 'Game not found' });
      }

      // Leave any previously joined game room
      const prevGame = socketGameMap.get(socket.id);
      if (prevGame && prevGame !== gameId) {
        socket.leave(prevGame);
        socketGameMap.delete(socket.id);
      }

      socket.join(gameId);
      socketGameMap.set(socket.id, gameId);

      // For games still in the lobby, add the player idempotently so that
      // joining via REST + socket (the normal flow) always results in a
      // consistent player list broadcast to everyone already in the room.
      if (state.status === 'waiting') {
        gameManager.addPlayerToLobby(gameId, currentUser.sub, currentUser.username);
      }

      gameManager.setPlayerConnected(gameId, currentUser.sub, true);

      // Always read the freshest state after the mutations above
      const latestState = gameManager.getGame(gameId);

      // Send full state to the joining client
      socket.emit('game:state', { state: latestState });

      // Notify everyone else in the room with the updated player list
      socket.to(gameId).emit('game:update', {
        state: latestState,
        events: [{ type: 'PLAYER_JOINED_LOBBY', data: { username: currentUser.username }, timestamp: Date.now() }],
      });

      // Update lobby lists on all connected clients (player count changed)
      broadcastLobbyUpdate();

      ack?.({ success: true });
    });

    // ── leave game room ──────────────────────────────────────────────────────

    socket.on('leave_game', () => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return;

      socket.leave(gameId);
      socketGameMap.delete(socket.id);
      gameManager.setPlayerConnected(gameId, currentUser.sub, false);

      io.to(gameId).emit('game:update', {
        state:  gameManager.getGame(gameId),
        events: [{ type: 'PLAYER_DISCONNECTED', data: { username: currentUser.username }, timestamp: Date.now() }],
      });
    });

    // ── disconnect ───────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      console.log(`[socket] ${currentUser.username} disconnected (${socket.id})`);
      const gameId = socketGameMap.get(socket.id);
      if (gameId) {
        socketGameMap.delete(socket.id);
        gameManager.setPlayerConnected(gameId, currentUser.sub, false);

        io.to(gameId).emit('game:update', {
          state:  gameManager.getGame(gameId),
          events: [{ type: 'PLAYER_DISCONNECTED', data: { username: currentUser.username }, timestamp: Date.now() }],
        });
      }
    });

    // ── helper: dispatch a game action and broadcast result ──────────────────

    function dispatchAction(action, payload = {}) {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) {
        socket.emit('game:error', { message: 'You are not in a game' });
        return;
      }

      const result = gameManager.applyAction(gameId, currentUser.sub, action, payload);

      if (result.error) {
        socket.emit('game:error', { message: result.error });
        return;
      }

      // Broadcast updated state + events to everyone in the room
      io.to(gameId).emit('game:update', {
        state:  result.state,
        events: result.events,
      });
    }

    // ── game start ───────────────────────────────────────────────────────────

    socket.on('game:start', () => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return socket.emit('game:error', { message: 'Not in a game' });

      const result = gameManager.startGame(gameId, currentUser.sub);
      if (result.error) return socket.emit('game:error', { message: result.error });

      io.to(gameId).emit('game:update', {
        state:  result.state,
        events: result.events,
      });

      // Game status changed to 'playing' — update lobby lists everywhere
      broadcastLobbyUpdate();
    });

    // ── join lobby ───────────────────────────────────────────────────────────

    socket.on('lobby:join', (gameId, ack) => {
      const result = gameManager.addPlayerToLobby(gameId, currentUser.sub, currentUser.username);
      if (result.error) return ack?.({ error: result.error });

      socket.join(gameId);
      socketGameMap.set(socket.id, gameId);

      io.to(gameId).emit('game:update', {
        state:  result.state,
        events: [{ type: 'PLAYER_JOINED_LOBBY', data: { username: currentUser.username }, timestamp: Date.now() }],
      });

      ack?.({ success: true, state: result.state });
    });

    // ── turn actions ─────────────────────────────────────────────────────────

    socket.on('turn:rollDice',       ()        => dispatchAction('rollDice'));
    socket.on('turn:buyProperty',    ()        => dispatchAction('buyProperty'));
    socket.on('turn:declinePurchase',()        => dispatchAction('declinePurchase'));
    socket.on('turn:auction:bid',    (payload) => dispatchAction('placeBid', payload));
    socket.on('turn:auction:pass',   ()        => dispatchAction('passAuction'));
    socket.on('turn:buildHouse',     (payload) => dispatchAction('buildHouse', payload));
    socket.on('turn:sellHouse',      (payload) => dispatchAction('sellHouse', payload));
    socket.on('turn:mortgage',       (payload) => dispatchAction('mortgageProperty', payload));
    socket.on('turn:unmortgage',     (payload) => dispatchAction('unmortgageProperty', payload));
    socket.on('turn:payJailFine',    ()        => dispatchAction('payJailFine'));
    socket.on('turn:useJailCard',    ()        => dispatchAction('useJailCard'));
    socket.on('turn:endTurn',        ()        => dispatchAction('endTurn'));

    // ── trade events ─────────────────────────────────────────────────────────

    socket.on('trade:offer', (payload) => {
      dispatchAction('offerTrade', payload);
      // Also send a targeted notification to the trade recipient
      const gameId = socketGameMap.get(socket.id);
      if (!gameId || !payload.toUserId) return;
      // Find the recipient's socket
      const recipientSocketId = findSocketForUser(payload.toUserId, gameId);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('trade:incoming', {
          from: currentUser.username,
          payload,
        });
      }
    });

    socket.on('trade:accept',  () => dispatchAction('acceptTrade'));
    socket.on('trade:reject',  () => dispatchAction('rejectTrade'));
    socket.on('trade:cancel',  () => dispatchAction('cancelTrade'));

    // ── bankruptcy ───────────────────────────────────────────────────────────

    socket.on('game:bankruptcy', () => dispatchAction('declareBankruptcy'));

    // ── save game ────────────────────────────────────────────────────────────

    socket.on('game:save', (ack) => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return ack?.({ error: 'Not in a game' });

      const result = gameManager.saveGame(gameId, currentUser.sub);
      if (result.error) {
        socket.emit('game:error', { message: result.error });
        return ack?.({ error: result.error });
      }

      io.to(gameId).emit('game:saved', { savedBy: currentUser.username });
      ack?.({ success: true });
    });

    // ── chat ─────────────────────────────────────────────────────────────────

    socket.on('chat:message', ({ text }) => {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim().slice(0, 300); // max 300 chars
      if (!trimmed) return;

      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return;

      io.to(gameId).emit('chat:message', {
        username:  currentUser.username,
        text:      trimmed,
        timestamp: Date.now(),
      });
    });

  }); // end io.on('connection')

  // ── helper to find socket id for a user in a game room ──────────────────

  function findSocketForUser(userId, gameId) {
    const room = io.sockets.adapter.rooms.get(gameId);
    if (!room) return null;
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s._user?.sub === userId) return sid;
    }
    return null;
  }
}

module.exports = { registerHandlers, broadcastLobbyUpdate };
