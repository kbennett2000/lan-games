/**
 * socket-handler.js
 *
 * Wires all Socket.io real-time events for game play.
 * Game-agnostic: all game-specific behaviour is delegated to the game-logic
 * module selected by game-registry based on the game's gameType field.
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
 *   game:start              host starts the game
 *   game:action  { action, ...payload }  any player action (roll, buy, trade, …)
 *   game:save
 *   chat:message { text }
 *
 * Server → client broadcasts (to the game room)
 * ───────────────────────────────────────────────
 *   game:state         full GameState (on join)
 *   game:update        { state, events[] }  after every action
 *   game:error         { message }  (to the acting socket only)
 *   trade:incoming     { from, payload }  targeted to the trade recipient
 *   chat:message       { username, text, timestamp }
 */

'use strict';

const { authenticateSocket } = require('./auth');
const gameManager             = require('./game-manager');
const gameRegistry            = require('./game-registry');

// Track which socket is in which game room: Map<socketId, gameId>
const socketGameMap = new Map();
// Track each user's active socket for targeted emissions: Map<userId, socketId>
const userSocketMap = new Map();

// ── turn timeout ──────────────────────────────────────────────────────────────
// When a player disconnects mid-turn, auto-skip after TURN_TIMEOUT_MS.

const TURN_TIMEOUT_MS = 30_000;
const turnTimers = new Map(); // key: `${gameId}:${userId}` → timer handle

function scheduleTurnTimeout(io, gameId, userId, username) {
  const key = `${gameId}:${userId}`;
  clearTurnTimeout(key);
  io.to(gameId).emit('game:turn_warning', { username, secondsRemaining: TURN_TIMEOUT_MS / 1000 });
  turnTimers.set(key, setTimeout(async () => {
    turnTimers.delete(key);
    const state = gameManager.getGame(gameId);
    if (!state || state.status !== 'playing') return;
    const logic = gameRegistry.getGameLogic(state.gameType || 'monopoly');
    const cur   = logic.getCurrentPlayer(state);
    // Only fire if it's still this player's turn and they're still disconnected
    if (!cur || cur.userId !== userId) return;
    const player = state.players.find(p => p.userId === userId);
    if (player?.connected) return;
    if (logic.isTurnTimerBlocked(state)) return;
    const result = await gameManager.applyAction(gameId, userId, 'skipTurn', {});
    if (!result.error) {
      io.to(gameId).emit('game:update', { state: result.state, events: result.events });
    }
  }, TURN_TIMEOUT_MS));
}

function clearTurnTimeout(key) {
  if (turnTimers.has(key)) {
    clearTimeout(turnTimers.get(key));
    turnTimers.delete(key);
  }
}

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
    userSocketMap.set(currentUser.sub, socket.id);

    // ── join game room ───────────────────────────────────────────────────────

    socket.on('join_game', async (gameId, ack) => {
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
        gameManager.addPlayerToLobby(gameId, { id: currentUser.sub, username: currentUser.username });
      }

      await gameManager.setPlayerConnected(gameId, currentUser.sub, true);
      // Cancel any pending turn-skip timer now that this player is back
      clearTurnTimeout(`${gameId}:${currentUser.sub}`);

      // Auto-resume paused (saved) games when a player rejoins
      if (state.status === 'paused') {
        await gameManager.resumeGame(gameId);
      }

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

    socket.on('leave_game', async () => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return;

      socket.leave(gameId);
      socketGameMap.delete(socket.id);
      clearTurnTimeout(`${gameId}:${currentUser.sub}`);
      await gameManager.setPlayerConnected(gameId, currentUser.sub, false);

      io.to(gameId).emit('game:update', {
        state:  gameManager.getGame(gameId),
        events: [{ type: 'PLAYER_DISCONNECTED', data: { username: currentUser.username }, timestamp: Date.now() }],
      });
    });

    // ── disconnect ───────────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
      console.log(`[socket] ${currentUser.username} disconnected (${socket.id})`);

      // Only remove from userSocketMap if this socket is still the active one
      // (a reconnect may have already registered a new socketId for this user)
      if (userSocketMap.get(currentUser.sub) === socket.id) {
        userSocketMap.delete(currentUser.sub);
      }

      const gameId = socketGameMap.get(socket.id);
      if (gameId) {
        socketGameMap.delete(socket.id);
        await gameManager.setPlayerConnected(gameId, currentUser.sub, false);

        const state = gameManager.getGame(gameId);
        io.to(gameId).emit('game:update', {
          state,
          events: [{ type: 'PLAYER_DISCONNECTED', data: { username: currentUser.username }, timestamp: Date.now() }],
        });

        // If it was this player's turn, start the auto-skip countdown
        if (state && state.status === 'playing') {
          const logic = gameRegistry.getGameLogic(state.gameType || 'monopoly');
          const cur   = logic.getCurrentPlayer(state);
          if (cur?.userId === currentUser.sub && !logic.isTurnTimerBlocked(state)) {
            scheduleTurnTimeout(io, gameId, currentUser.sub, currentUser.username);
          }
        }
      }
    });

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
      const result = gameManager.addPlayerToLobby(gameId, { id: currentUser.sub, username: currentUser.username });
      if (result.error) return ack?.({ error: result.error });

      socket.join(gameId);
      socketGameMap.set(socket.id, gameId);

      io.to(gameId).emit('game:update', {
        state:  result.state,
        events: [{ type: 'PLAYER_JOINED_LOBBY', data: { username: currentUser.username }, timestamp: Date.now() }],
      });

      ack?.({ success: true, state: result.state });
    });

    // ── game action (single generic handler for all player actions) ──────────

    socket.on('game:action', async (payload) => {
      const { action, ...data } = payload || {};
      if (!action) {
        socket.emit('game:error', { message: 'Missing action type' });
        return;
      }

      const gameId = socketGameMap.get(socket.id);
      if (!gameId) {
        socket.emit('game:error', { message: 'Not in a game' });
        return;
      }

      const result = await gameManager.applyAction(gameId, currentUser.sub, action, data);

      if (result.error) {
        socket.emit('game:error', { message: result.error });
        return;
      }

      io.to(gameId).emit('game:update', { state: result.state, events: result.events });

      // If the action resulted in a trade offer, notify the recipient directly
      const tradeEvent = result.events?.find(e => e.type === 'TRADE_OFFERED');
      if (tradeEvent && data.toUserId) {
        const recipientSid = userSocketMap.get(data.toUserId);
        if (recipientSid) {
          io.to(recipientSid).emit('trade:incoming', { from: currentUser.username, payload: data });
        }
      }
    });

    // ── save game ────────────────────────────────────────────────────────────

    socket.on('game:save', async (ack) => {
      const gameId = socketGameMap.get(socket.id);
      if (!gameId) return ack?.({ error: 'Not in a game' });

      const result = await gameManager.saveGame(gameId, currentUser.sub);
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

}

module.exports = { registerHandlers, broadcastLobbyUpdate };
