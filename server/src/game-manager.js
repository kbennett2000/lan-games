/**
 * game-manager.js
 *
 * Manages the lifecycle of all active game sessions.  Keeps an in-memory
 * map of running games (GameState objects) and syncs them to the database
 * when they change.  All game logic is delegated to game-logic.js.
 *
 * The singleton pattern is intentional — Node.js modules are cached after
 * the first require(), so all parts of the server share the same instance.
 */

'use strict';

const { v4: uuidv4 }    = require('uuid');
const database           = require('./database');
const { getConfigCopy }  = require('./config-loader');
const gameLogic          = require('./game-logic');

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
 * @param {string}  name       Human-readable game name
 * @param {string}  hostUserId UUID of the creating user
 * @param {object}  [configOverrides]  Optional overrides to merge into config
 * @returns {{ gameId, state }}
 */
function createGame(name, hostUserId, configOverrides = {}) {
  const gameId = uuidv4();
  const config = getConfigCopy();

  // Apply any per-game config overrides (e.g. rule tweaks sent from client)
  if (configOverrides.settings) {
    Object.assign(config.settings, configOverrides.settings);
  }
  if (configOverrides.board) {
    config.board = configOverrides.board;
  }
  if (configOverrides.cards) {
    if (configOverrides.cards.chance)        config.cards.chance        = configOverrides.cards.chance;
    if (configOverrides.cards.communityChest) config.cards.communityChest = configOverrides.cards.communityChest;
  }

  // Placeholder state (no players yet — they join before starting)
  const placeholderState = {
    id:        gameId,
    name,
    createdBy: hostUserId,  // embedded so all clients can derive host status
    status:    'waiting',
    config,
    players:   [],
    properties: {},
    turnState:  null,
    auction:    null,
    trade:      null,
    chanceDeck: [],
    chestDeck:  [],
    freeParking: 0,
    log: [],
  };

  database.createGame(gameId, name, hostUserId, placeholderState, config);
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

  // Back-fill createdBy from the DB column for games saved before this field
  // was embedded in the state JSON.
  if (!row.state.createdBy && row.created_by) {
    row.state.createdBy = row.created_by;
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
 * Called when a user joins a game that hasn't started yet.
 */
function addPlayerToLobby(gameId, userId, username) {
  const state = getGame(gameId);
  if (!state) return { error: 'Game not found' };
  if (state.status !== 'waiting') return { error: 'Game already in progress' };
  if (state.players.length >= state.config.settings.maxPlayers) {
    return { error: 'Game is full' };
  }
  if (state.players.find(p => p.userId === userId)) {
    return { state }; // already in lobby — idempotent
  }

  // Assign a color and token from the config
  const usedColors = new Set(state.players.map(p => p.color));
  const color = state.config.settings.playerColors.find(c => !usedColors.has(c.id));
  const token = state.config.settings.playerTokens[state.players.length] || '🎲';

  state.players.push({
    userId,
    username,
    color:     color ? color.id : 'gray',
    colorHex:  color ? color.hex : '#999',
    token,
    position:  0,
    money:     0, // set properly when game starts
    inJail:    false,
    jailTurns: 0,
    jailCards: 0,
    isBankrupt: false,
    connected: true,
  });

  database.addPlayerToGame(gameId, userId);
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

  if (state.players.length < state.config.settings.minPlayersToStart) {
    return { error: `Need at least ${state.config.settings.minPlayersToStart} players to start` };
  }

  const playerList = state.players.map(p => ({
    userId:   p.userId,
    username: p.username,
    color:    p.color,
    colorHex: p.colorHex,
    token:    p.token,
  }));

  const newState = gameLogic.initGame(gameId, state.name, playerList, state.config);
  newState.createdBy = state.createdBy || hostUserId; // carry host identity forward
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

  let result;

  switch (action) {
    case 'rollDice':
      result = gameLogic.rollDice(state, userId);
      break;

    case 'buyProperty':
      result = gameLogic.buyProperty(state, userId);
      break;

    case 'declinePurchase':
      result = gameLogic.declinePurchase(state, userId);
      break;

    case 'placeBid':
      result = gameLogic.placeBid(state, userId, payload.amount);
      break;

    case 'passAuction':
      result = gameLogic.passAuction(state, userId);
      break;

    case 'buildHouse':
      result = gameLogic.buildHouse(state, userId, payload.position);
      break;

    case 'sellHouse':
      result = gameLogic.sellHouse(state, userId, payload.position);
      break;

    case 'mortgageProperty':
      result = gameLogic.mortgageProperty(state, userId, payload.position);
      break;

    case 'unmortgageProperty':
      result = gameLogic.unmortgageProperty(state, userId, payload.position);
      break;

    case 'payJailFine':
      result = gameLogic.payJailFine(state, userId);
      break;

    case 'useJailCard':
      result = gameLogic.useJailCard(state, userId);
      break;

    case 'endTurn':
      result = gameLogic.endTurn(state, userId);
      break;

    case 'offerTrade':
      result = gameLogic.offerTrade(
        state, userId,
        payload.toUserId,
        payload.offerMoney    || 0,
        payload.offerProps    || [],
        payload.offerCards    || 0,
        payload.requestMoney  || 0,
        payload.requestProps  || [],
        payload.requestCards  || 0,
      );
      break;

    case 'acceptTrade':
      result = gameLogic.acceptTrade(state, userId);
      break;

    case 'rejectTrade':
      result = gameLogic.rejectTrade(state, userId);
      break;

    case 'cancelTrade':
      result = gameLogic.cancelTrade(state, userId);
      break;

    case 'declareBankruptcy': {
      const playerIdx = state.players.findIndex(p => p.userId === userId);
      if (playerIdx < 0) return { state, events: [], error: 'Player not found' };
      result = gameLogic.declareBankruptcy(state, playerIdx, null);
      break;
    }

    case 'skipTurn':
      result = gameLogic.skipTurn(state, userId);
      break;

    default:
      return { state, events: [], error: `Unknown action: ${action}` };
  }

  if (result.error) {
    return { state, events: [], error: result.error };
  }

  // Update in-memory state and persist to DB
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
  setPlayerConnected,
  evictGame,
};
