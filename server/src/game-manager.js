/**
 * game-manager.js
 *
 * Manages the lifecycle of all active game sessions.  Keeps an in-memory
 * map of running games (GameState objects) and syncs them to the database
 * when they change.
 *
 * This module is intentionally game-agnostic: all game-specific behaviour is
 * delegated to the appropriate game-logic module via game-registry.js.
 * The only Monopoly-specific string that appears here is the default value
 * 'monopoly' used when a game record predates the gameType column.
 *
 * The singleton pattern is intentional — Node.js modules are cached after
 * the first require(), so all parts of the server share the same instance.
 */

'use strict';

const { v4: uuidv4 }  = require('uuid');
const database        = require('./database');
const gameRegistry    = require('./game-registry');

/** Return the game-logic module for a given state (falls back to monopoly). */
function getLogic(state) {
  return gameRegistry.getGameLogic(state?.gameType || 'monopoly');
}

// ── in-memory store ──────────────────────────────────────────────────────────

// Map of gameId → GameState (active games only)
const activeGames = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

function persist(state) {
  database.updateGame(state.id, state.status, state);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Create a brand-new game in 'waiting' state.
 *
 * @param {string} name           Human-readable game name
 * @param {string} hostUserId     UUID of the creating user
 * @param {string} [gameType]     Registered game type key (default 'monopoly')
 * @param {object} [configOverrides]  Optional overrides merged into the config
 * @returns {{ gameId, state }}
 */
function createGame(name, hostUserId, gameType = 'monopoly', configOverrides = {}) {
  const gameId = uuidv4();
  const logic  = gameRegistry.getGameLogic(gameType);
  const config = logic.getConfigCopy();

  // Merge per-game rule tweaks sent from the client
  if (configOverrides.settings)              Object.assign(config.settings, configOverrides.settings);
  if (configOverrides.board)                 config.board = configOverrides.board;
  if (configOverrides.cards?.chance)         config.cards.chance = configOverrides.cards.chance;
  if (configOverrides.cards?.communityChest) config.cards.communityChest = configOverrides.cards.communityChest;

  const { minPlayers, maxPlayers } = logic.getGameMetadata();

  // Minimal waiting-room state — no game-specific fields yet
  const placeholderState = {
    id:        gameId,
    name,
    gameType,
    createdBy: hostUserId,
    status:    'waiting',
    config,
    minPlayers,
    maxPlayers,
    players:   [],
  };

  database.createGame(gameId, name, hostUserId, placeholderState, config, gameType);
  database.addPlayerToGame(gameId, hostUserId);
  activeGames.set(gameId, placeholderState);

  return { gameId, state: placeholderState };
}

/**
 * Load a saved/paused game back into memory.
 *
 * @param {string} gameId
 * @returns {GameState | null}
 */
function loadGame(gameId) {
  if (activeGames.has(gameId)) return activeGames.get(gameId);

  const row = database.getGameById(gameId);
  if (!row) return null;

  // Back-fill fields from DB columns for games saved before they were
  // embedded in the state JSON.
  if (!row.state.createdBy && row.created_by) {
    row.state.createdBy = row.created_by;
  }
  if (!row.state.gameType && row.game_type) {
    row.state.gameType = row.game_type;
  }

  activeGames.set(gameId, row.state);
  return row.state;
}

/**
 * Get the in-memory state for a running game, or load it from DB.
 */
function getGame(gameId) {
  return activeGames.get(gameId) || loadGame(gameId);
}

/**
 * Return a public (safe-to-send) representation of all open games.
 */
function listOpenGames() {
  return database.listOpenGames();
}

/**
 * Add a player to the waiting-room player list.
 *
 * @param {string} gameId
 * @param {Object} user   - { id, username } from the auth system
 */
function addPlayerToLobby(gameId, user) {
  const state = getGame(gameId);
  if (!state) return { error: 'Game not found' };
  if (state.status !== 'waiting') return { error: 'Game already in progress' };

  const logic = getLogic(state);
  const { maxPlayers } = logic.getGameMetadata();
  if (state.players.length >= maxPlayers) return { error: 'Game is full' };

  if (state.players.find(p => p.userId === user.id)) {
    return { state }; // idempotent
  }

  const player = logic.createInitialPlayer(user, state.players, state.config);
  state.players.push(player);

  database.addPlayerToGame(gameId, user.id);
  persist(state);

  return { state };
}

/**
 * Remove a player from a waiting-room lobby.
 */
function removePlayerFromLobby(gameId, userId) {
  const state = getGame(gameId);
  if (!state || state.status !== 'waiting') return;

  state.players = state.players.filter(p => p.userId !== userId);
  database.removePlayerFromGame(gameId, userId);
  persist(state);
}

/**
 * Start a waiting game.  The host calls this once all players are ready.
 *
 * @param {string} gameId
 * @param {string} hostUserId  Only the host can start the game
 * @returns {{ state, events, error? }}
 */
function startGame(gameId, hostUserId) {
  const state = getGame(gameId);
  if (!state)                    return { error: 'Game not found' };
  if (state.status !== 'waiting') return { error: 'Game is not in waiting state' };

  const dbGame = database.getGameById(gameId);
  if (dbGame.created_by !== hostUserId) return { error: 'Only the host can start the game' };

  const logic = getLogic(state);
  const { minPlayers } = logic.getGameMetadata();
  if (state.players.length < minPlayers) {
    return { error: `Need at least ${minPlayers} players to start` };
  }

  const newState = logic.initGame(gameId, state.name, state.players, state.config);
  newState.createdBy = state.createdBy || hostUserId;
  newState.gameType  = state.gameType  || 'monopoly';
  activeGames.set(gameId, newState);
  persist(newState);

  return { state: newState, events: [{ type: 'GAME_STARTED', data: { players: playerList }, timestamp: Date.now() }] };
}

/**
 * Apply a game action dispatched by a player.
 * All actions go through this single entry point which calls the appropriate
 * game-logic function and then persists the updated state.
 *
 * @param {string} gameId
 * @param {string} userId   The acting player
 * @param {string} action   Action name (matches exported game-logic functions)
 * @param {object} [payload]  Additional data for the action
 * @returns {{ state, events, error? }}
 */
function applyAction(gameId, userId, action, payload = {}) {
  const state = getGame(gameId);
  if (!state) return { state: null, events: [], error: 'Game not found' };
  if (state.status !== 'playing') return { state, events: [], error: 'Game is not in playing state' };

  const result = getLogic(state).applyAction(state, userId, action, payload);

  if (result.error) {
    return { state, events: [], error: result.error };
  }

  activeGames.set(gameId, result.state);
  persist(result.state);

  return { state: result.state, events: result.events };
}

/**
 * Delete a game permanently.  Only the host may delete, and only if the game
 * is in 'waiting' or 'paused' state (not actively playing).
 */
function deleteGame(gameId, userId) {
  const dbGame = database.getGameById(gameId);
  if (!dbGame) return { error: 'Game not found' };
  if (dbGame.created_by !== userId) return { error: 'Only the host can delete a game' };
  if (dbGame.status === 'playing') return { error: 'Cannot delete a game in progress — save it first' };

  activeGames.delete(gameId);
  database.deleteGame(gameId);
  return { success: true };
}

/**
 * Resume a paused game, setting its status back to 'playing'.
 */
function resumeGame(gameId) {
  const state = getGame(gameId);
  if (!state || state.status !== 'paused') return;
  state.status = 'playing';
  persist(state);
}

/**
 * Save (pause) a game so it can be resumed later.
 */
function saveGame(gameId, userId) {
  const state = getGame(gameId);
  if (!state) return { error: 'Game not found' };

  const dbGame = database.getGameById(gameId);
  if (dbGame.created_by !== userId) return { error: 'Only the host can save the game' };

  state.status = 'paused';
  persist(state);

  return { success: true };
}

/**
 * Mark a player as (dis)connected.  Disconnected players can still own
 * property and the game continues; their turn is skipped after a timeout
 * (handled externally by the socket handler).
 */
function setPlayerConnected(gameId, userId, connected) {
  const state = getGame(gameId);
  if (!state) return;
  const player = state.players.find(p => p.userId === userId);
  if (player) player.connected = connected;
  persist(state);
}

/**
 * Remove a game from the in-memory cache (e.g. when all players leave).
 */
function evictGame(gameId) {
  activeGames.delete(gameId);
}

module.exports = {
  createGame,
  loadGame,
  getGame,
  listOpenGames,
  addPlayerToLobby,
  removePlayerFromLobby,
  startGame,
  applyAction,
  deleteGame,
  saveGame,
  resumeGame,
  setPlayerConnected,
  evictGame,
};
