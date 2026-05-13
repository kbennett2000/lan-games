'use strict';

/**
 * Connect Four game-logic module.
 * Implements the GameLogic interface defined in server/src/game-logic-interface.js.
 *
 * State shape:
 *   {
 *     id, name, gameType, createdBy, stateVersion, status, config,
 *     players: [{ userId, username, color, colorHex, token, active, connected }],
 *     board:   number[][] — [row][col], null = empty, userId = piece owner
 *              row 0 is the TOP, row (height-1) is the BOTTOM
 *     turnState: { currentPlayerIndex, phase: 'drop' }
 *     winner:  string | null   (userId of winner, or null for draw)
 *     log:     [{ message, type, timestamp }]
 *   }
 */

const fs   = require('fs');
const path = require('path');
const { validateImplementation, defaultGetStateForPlayer } = require('../../src/game-logic-interface');

// Bump this whenever the GameState shape changes incompatibly.
// game-manager.js will call migrate() for any saved game whose
// stateVersion doesn't match.
const STATE_VERSION = 1;

const CONFIG_DIR = path.join(__dirname, 'config');
let _config = null;

// ── config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const settings = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.json'), 'utf8'));
  _config = { settings };
  return _config;
}

function getConfigCopy() {
  if (!_config) loadConfig();
  return JSON.parse(JSON.stringify(_config));
}

// ── metadata ──────────────────────────────────────────────────────────────────

function getGameMetadata() {
  return {
    name:        'Connect Four',
    description: 'Drop pieces to connect four in a row.',
    minPlayers:  2,
    maxPlayers:  2,
    icon:        '🔴',
  };
}

// ── player creation ───────────────────────────────────────────────────────────

function createInitialPlayer(user, existingPlayers = [], config = null) {
  const cfg    = config || getConfigCopy();
  const colors = cfg.settings.playerColors;
  const tokens = cfg.settings.playerTokens || ['🔴', '🟡'];
  const idx    = existingPlayers.length;
  const colorObj = colors[idx] || colors[0];
  return {
    userId:    user.id,
    username:  user.username,
    color:     colorObj.id,
    colorHex:  colorObj.hex,
    token:     tokens[idx] || colorObj.id,
    active:    true,
    isBankrupt: false, // keep field for framework compatibility
    connected: true,
  };
}

// ── game initialisation ───────────────────────────────────────────────────────

function initGame(gameId, name, players, config) {
  const cfg = config || getConfigCopy();
  const { boardWidth, boardHeight } = cfg.settings;

  const board = Array.from({ length: boardHeight }, () => Array(boardWidth).fill(null));

  return {
    id:           gameId,
    name,
    gameType:     'connect-four',
    stateVersion: STATE_VERSION,
    status:       'playing',
    config:       cfg,
    players:      players.map(p => ({ ...p })),
    board,
    turnState:    { currentPlayerIndex: 0, phase: 'drop' },
    winner:       null,
    log:          [],
  };
}

// ── turn helpers ──────────────────────────────────────────────────────────────

function getCurrentPlayer(state) {
  if (!state?.turnState) return null;
  return state.players[state.turnState.currentPlayerIndex] || null;
}

function isTurnTimerBlocked(_state) {
  return false; // no phases that block auto-skip
}

function getValidActions(state, userId) {
  if (state.status !== 'playing') return [];
  const cur = getCurrentPlayer(state);
  if (!cur || cur.userId !== userId) return [];
  const { boardWidth } = state.config.settings;
  const actions = [];
  for (let col = 0; col < boardWidth; col++) {
    if (state.board[0][col] === null) actions.push(`dropPiece:${col}`);
  }
  return actions;
}

// ── win detection ─────────────────────────────────────────────────────────────

function checkWinner(board, row, col, userId, winLength) {
  const height = board.length;
  const width  = board[0].length;
  // Four directions: horizontal, vertical, diagonal-↘, diagonal-↙
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];

  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let i = 1; i < winLength; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r < 0 || r >= height || c < 0 || c >= width || board[r][c] !== userId) break;
      count++;
    }
    for (let i = 1; i < winLength; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r < 0 || r >= height || c < 0 || c >= width || board[r][c] !== userId) break;
      count++;
    }
    if (count >= winLength) return true;
  }
  return false;
}

function isBoardFull(board) {
  return board[0].every(cell => cell !== null);
}

// ── actions ───────────────────────────────────────────────────────────────────

function dropPiece(state, userId, column) {
  const cur = getCurrentPlayer(state);
  if (!cur || cur.userId !== userId) {
    return { state, events: [], error: 'Not your turn' };
  }
  if (state.status !== 'playing') {
    return { state, events: [], error: 'Game is not in playing state' };
  }

  const { boardWidth, boardHeight, winLength } = state.config.settings;
  const col = Number(column);
  if (!Number.isInteger(col) || col < 0 || col >= boardWidth) {
    return { state, events: [], error: 'Invalid column' };
  }

  const newBoard = state.board.map(r => [...r]);

  // Find the lowest empty row in the column (board[0] = top)
  let row = -1;
  for (let r = boardHeight - 1; r >= 0; r--) {
    if (newBoard[r][col] === null) { row = r; break; }
  }
  if (row === -1) {
    return { state, events: [], error: 'Column is full' };
  }

  newBoard[row][col] = userId;

  const player  = state.players.find(p => p.userId === userId);
  const events  = [];
  events.push({ type: 'PIECE_DROPPED', data: { username: player.username, column: col, row }, timestamp: Date.now() });

  let newStatus = 'playing';
  let winner    = null;
  let logMsg    = `${player.username} dropped in column ${col + 1}`;
  let logType   = 'move';

  if (checkWinner(newBoard, row, col, userId, winLength)) {
    newStatus = 'finished';
    winner    = userId;
    logMsg    = `${player.username} wins!`;
    logType   = 'game';
    events.push({ type: 'GAME_OVER', data: { winner: player.username }, timestamp: Date.now() });
  } else if (isBoardFull(newBoard)) {
    newStatus = 'finished';
    logMsg    = "It's a draw!";
    logType   = 'game';
    events.push({ type: 'GAME_OVER', data: { winner: null }, timestamp: Date.now() });
  }

  const nextIdx = newStatus === 'playing'
    ? (state.turnState.currentPlayerIndex + 1) % state.players.length
    : state.turnState.currentPlayerIndex;

  const newState = {
    ...state,
    board:     newBoard,
    status:    newStatus,
    winner,
    turnState: { ...state.turnState, currentPlayerIndex: nextIdx },
    log: [...(state.log || []), { message: logMsg, type: logType, timestamp: Date.now() }],
  };

  return { state: newState, events };
}

function skipTurn(state, userId) {
  const cur = getCurrentPlayer(state);
  if (!cur || cur.userId !== userId) {
    return { state, events: [], error: 'Not this player\'s turn' };
  }

  const nextIdx  = (state.turnState.currentPlayerIndex + 1) % state.players.length;
  const newState = {
    ...state,
    turnState: { ...state.turnState, currentPlayerIndex: nextIdx },
    log: [...(state.log || []), { message: `${cur.username}'s turn was skipped`, type: 'info', timestamp: Date.now() }],
  };

  return {
    state:  newState,
    events: [{ type: 'TURN_SKIPPED', data: { username: cur.username }, timestamp: Date.now() }],
  };
}

// ── applyAction dispatcher ────────────────────────────────────────────────────

function applyAction(state, userId, action, payload = {}) {
  switch (action) {
    case 'dropPiece': return dropPiece(state, userId, payload.column);
    case 'skipTurn':  return skipTurn(state, userId);
    default:          return { state, events: [], error: `Unknown action: ${action}` };
  }
}

// ── exports ───────────────────────────────────────────────────────────────────

/**
 * Upgrade a persisted state to the current STATE_VERSION.
 * Add a new `if` branch for each version bump.  See game-logic-interface.js
 * for the full contract.
 *
 * @param   {Object} state  Saved state with stateVersion < STATE_VERSION.
 * @returns {Object}        New state with stateVersion === STATE_VERSION.
 * @throws  {Error}         If no migration path exists for the given version.
 */
function migrate(state) {
  // No structural changes yet — STATE_VERSION 1 is the initial release.
  // Future migrations follow this pattern:
  //
  //   if (state.stateVersion < 2) {
  //     state = { ...state, newField: defaultValue, stateVersion: 2 };
  //   }

  throw new Error(
    `[connect-four] No migration path from stateVersion ${state.stateVersion} to ${STATE_VERSION}`,
  );
}

module.exports = {
  STATE_VERSION,
  initGame,
  createInitialPlayer,
  applyAction,
  skipTurn,
  getCurrentPlayer,
  isTurnTimerBlocked,
  getValidActions,
  getGameMetadata,
  loadConfig,
  getConfigCopy,
  getStateForPlayer: defaultGetStateForPlayer,
  migrate,
};

// Validate interface compliance at load time
validateImplementation(module.exports);
