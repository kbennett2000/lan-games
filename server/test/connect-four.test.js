'use strict';

const gl = require('../games/connect-four/game-logic');

// ── fixtures ──────────────────────────────────────────────────────────────────

const CF_CONFIG = {
  settings: {
    boardWidth:   7,
    boardHeight:  6,
    winLength:    4,
    playerColors: [
      { id: 'red',    hex: '#e53935' },
      { id: 'yellow', hex: '#fdd835' },
    ],
    playerTokens: ['🔴', '🟡'],
  },
};

const PLAYERS = [
  { userId: 'p1', username: 'Alice', color: 'red',    colorHex: '#e53935', token: '🔴', active: true, isBankrupt: false, connected: true },
  { userId: 'p2', username: 'Bob',   color: 'yellow', colorHex: '#fdd835', token: '🟡', active: true, isBankrupt: false, connected: true },
];

function emptyBoard() {
  return Array.from({ length: 6 }, () => Array(7).fill(null));
}

function makeCFState(overrides = {}) {
  return {
    id:        'test-game',
    name:      'Test Game',
    gameType:  'connect-four',
    status:    'playing',
    config:    CF_CONFIG,
    players:   PLAYERS.map(p => ({ ...p })),
    board:     emptyBoard(),
    turnState: { currentPlayerIndex: 0, phase: 'drop' },
    winner:    null,
    log:       [],
    ...overrides,
  };
}

// Build a full board with no winning sequence for either player, leaving
// cell (0,6) empty so the test can drop the final piece there.
//
// Pattern — cell (r,c) owner:
//   ((Math.floor(c/2) + r) % 2 === 0) ? 'p1' : 'p2'
//
// Expands to:
//   Rows 0,2,4: [p1, p1, p2, p2, p1, p1, p2]
//   Rows 1,3,5: [p2, p2, p1, p1, p2, p2, p1]
//
// Horizontal: max 2 consecutive same colour.
// Vertical:   strictly alternating per column.
// Diagonals:  every 4-cell window contains both colours (verified by hand).
function drawBoard() {
  const owner = (r, c) => (Math.floor(c / 2) + r) % 2 === 0 ? 'p1' : 'p2';
  const board = Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 7 }, (_, c) => owner(r, c))
  );
  board[0][6] = null; // the one empty cell — 'p2' will fill it last
  return board;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  initGame
// ═══════════════════════════════════════════════════════════════════════════════

describe('initGame', () => {
  const state = gl.initGame('g1', 'Test', PLAYERS, CF_CONFIG);

  test('sets status to playing', () => {
    expect(state.status).toBe('playing');
  });

  test('sets gameType to connect-four', () => {
    expect(state.gameType).toBe('connect-four');
  });

  test('creates an empty 6×7 board', () => {
    expect(state.board).toHaveLength(6);
    for (const row of state.board) {
      expect(row).toHaveLength(7);
      for (const cell of row) expect(cell).toBeNull();
    }
  });

  test('starts with player 0 in drop phase', () => {
    expect(state.turnState.currentPlayerIndex).toBe(0);
    expect(state.turnState.phase).toBe('drop');
  });

  test('winner is null', () => {
    expect(state.winner).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  dropPiece — basic mechanics
// ═══════════════════════════════════════════════════════════════════════════════

describe('dropPiece', () => {
  test('piece lands at the bottom of an empty column', () => {
    const { state, error } = gl.applyAction(makeCFState(), 'p1', 'dropPiece', { column: 3 });
    expect(error).toBeUndefined();
    expect(state.board[5][3]).toBe('p1'); // row 5 = bottom of a 6-row board
  });

  test('piece stacks on top of an existing piece in the same column', () => {
    const state = makeCFState();
    state.board[5][3] = 'p2'; // bottom row already occupied
    const { state: s } = gl.applyAction(state, 'p1', 'dropPiece', { column: 3 });
    expect(s.board[4][3]).toBe('p1'); // lands one row above the existing piece
  });

  test('emits PIECE_DROPPED event on a valid drop', () => {
    const { events } = gl.applyAction(makeCFState(), 'p1', 'dropPiece', { column: 0 });
    expect(events.some(e => e.type === 'PIECE_DROPPED')).toBe(true);
  });

  test('returns an error (does not throw) when the column is full', () => {
    const state = makeCFState();
    for (let r = 0; r < 6; r++) state.board[r][0] = 'p2'; // fill column 0
    const result = gl.applyAction(state, 'p1', 'dropPiece', { column: 0 });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/full/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Turn order
// ═══════════════════════════════════════════════════════════════════════════════

describe('turn alternation', () => {
  test('turn passes to player 2 after player 1 drops', () => {
    const { state } = gl.applyAction(makeCFState(), 'p1', 'dropPiece', { column: 0 });
    expect(state.turnState.currentPlayerIndex).toBe(1);
  });

  test('turn passes back to player 1 after player 2 drops', () => {
    const { state: s1 } = gl.applyAction(makeCFState(), 'p1', 'dropPiece', { column: 0 });
    const { state: s2 } = gl.applyAction(s1, 'p2', 'dropPiece', { column: 1 });
    expect(s2.turnState.currentPlayerIndex).toBe(0);
  });
});

describe('out-of-turn rejection', () => {
  test('rejects when it is not the caller\'s turn', () => {
    const { error } = gl.applyAction(makeCFState(), 'p2', 'dropPiece', { column: 0 });
    expect(error).toBeDefined();
    expect(error).toMatch(/turn/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Win detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('win detection', () => {
  test('horizontal: four in a row wins', () => {
    // p1 at (5,0),(5,1),(5,2) — drop at col 3 lands at row 5, completing [5][0..3]
    const state = makeCFState();
    state.board[5][0] = 'p1';
    state.board[5][1] = 'p1';
    state.board[5][2] = 'p1';
    const { state: s, events } = gl.applyAction(state, 'p1', 'dropPiece', { column: 3 });
    expect(s.status).toBe('finished');
    expect(s.winner).toBe('p1');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });

  test('vertical: four in a column wins', () => {
    // p1 at (5,0),(4,0),(3,0) — drop at col 0 lands at row 2, completing rows 2-5
    const state = makeCFState();
    state.board[5][0] = 'p1';
    state.board[4][0] = 'p1';
    state.board[3][0] = 'p1';
    const { state: s, events } = gl.applyAction(state, 'p1', 'dropPiece', { column: 0 });
    expect(s.status).toBe('finished');
    expect(s.winner).toBe('p1');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });

  test('diagonal ↘: four along [+row,+col] direction wins', () => {
    // Diagonal where row-col=2: (2,0),(3,1),(4,2),(5,3)
    // Pre-place p1 at (2,0),(3,1),(4,2); drop at col 3 lands at row 5
    // checkWinner sweeps backward from (5,3) and finds three more p1s
    const state = makeCFState();
    state.board[2][0] = 'p1';
    state.board[3][1] = 'p1';
    state.board[4][2] = 'p1';
    const { state: s, events } = gl.applyAction(state, 'p1', 'dropPiece', { column: 3 });
    expect(s.status).toBe('finished');
    expect(s.winner).toBe('p1');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });

  test('diagonal ↙: four along [+row,-col] direction wins', () => {
    // Diagonal where row+col=8: (2,6),(3,5),(4,4),(5,3)
    // Pre-place p1 at (2,6),(3,5),(4,4); drop at col 3 lands at row 5
    // checkWinner sweeps backward from (5,3) and finds three more p1s
    const state = makeCFState();
    state.board[2][6] = 'p1';
    state.board[3][5] = 'p1';
    state.board[4][4] = 'p1';
    const { state: s, events } = gl.applyAction(state, 'p1', 'dropPiece', { column: 3 });
    expect(s.status).toBe('finished');
    expect(s.winner).toBe('p1');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Draw detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('draw detection', () => {
  test('full board with no winner is a draw', () => {
    // drawBoard() fills 41/42 cells with no winning sequence; (0,6) is null.
    // col 6 has pieces in rows 1-5, so the drop lands at row 0 — the last cell.
    // The dropped piece is p2 (matching the board pattern), and checkWinner
    // returns false, so isBoardFull triggers the draw result.
    const state = makeCFState({
      board:     drawBoard(),
      turnState: { currentPlayerIndex: 1, phase: 'drop' }, // p2's turn
    });
    const { state: s, events } = gl.applyAction(state, 'p2', 'dropPiece', { column: 6 });
    expect(s.status).toBe('finished');
    expect(s.winner).toBeNull();
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
    expect(events.find(e => e.type === 'GAME_OVER').data.winner).toBeNull();
  });
});
