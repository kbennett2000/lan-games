/**
 * game-lifecycle.test.js
 *
 * End-to-end integration tests that spin up the real Express + Socket.io server
 * on an ephemeral port and exercise the full game lifecycle using real HTTP
 * requests (supertest) and real WebSocket connections (socket.io-client).
 *
 * Scenarios
 * ─────────
 *   1. Auth — register, login, /me
 *   2. Lobby — create, list, join
 *   3. Full Connect Four game — start → both players play → game over
 *   4. Save → disconnect → reconnect → auto-resume → continue playing
 *
 * Database
 * ────────
 * env-setup.js (loaded via jest "setupFiles") sets TEST_DB_PATH=':memory:' so
 * no SQLite file is written.  Each test clears all tables in beforeEach so
 * tests are fully isolated from each other.
 */

'use strict';

const { startServer, stopServer }               = require('./helpers/server');
const { connectSocket, disconnectSocket, waitFor, emitAck } = require('./helpers/socket');

// ── shared server state ────────────────────────────────────────────────────────

let server;   // { httpServer, io, url, api }

beforeAll(async () => {
  server = await startServer();
}, 15_000);

afterAll(async () => {
  await stopServer(server);
}, 10_000);

// Clear all database tables between tests so each scenario starts fresh.
// The game-manager's in-memory activeGames map is not cleared, but all
// game IDs are UUIDs so there is no cross-test interference.
beforeEach(() => {
  const db = require('../../src/database');
  db.db.exec('DELETE FROM game_players; DELETE FROM games; DELETE FROM users;');
});

// ── REST auth helpers ──────────────────────────────────────────────────────────

async function register(username, password = 'pass1234') {
  const res = await server.api
    .post('/api/auth/register')
    .send({ username, password })
    .expect(201);
  return res.body; // { token, user: { id, username } }
}

async function login(username, password = 'pass1234') {
  const res = await server.api
    .post('/api/auth/login')
    .send({ username, password })
    .expect(200);
  return res.body; // { token, user }
}

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

// ── socket connect helper ──────────────────────────────────────────────────────

// Keeps track of all sockets opened in the current test for cleanup.
let _openSockets = [];

async function connect(token) {
  const s = await connectSocket(server.url, token);
  _openSockets.push(s);
  return s;
}

afterEach(async () => {
  // Close any sockets that the test left open (e.g. after an assertion failure).
  await Promise.all(_openSockets.map(s => disconnectSocket(s)));
  _openSockets = [];
});

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Authentication
// ═══════════════════════════════════════════════════════════════════════════════

describe('auth', () => {

  test('register returns a JWT and user object', async () => {
    const { token, user } = await register('Alice');
    expect(typeof token).toBe('string');
    expect(user.username).toBe('Alice');
    expect(typeof user.id).toBe('string');
  });

  test('duplicate username returns 409', async () => {
    await register('Alice');
    await server.api
      .post('/api/auth/register')
      .send({ username: 'Alice', password: 'pass1234' })
      .expect(409);
  });

  test('login with correct credentials returns a JWT', async () => {
    await register('Bob');
    const { token } = await login('Bob');
    expect(typeof token).toBe('string');
  });

  test('login with wrong password returns 401', async () => {
    await register('Carol');
    await server.api
      .post('/api/auth/login')
      .send({ username: 'Carol', password: 'wrongpass' })
      .expect(401);
  });

  test('GET /api/auth/me returns current user', async () => {
    const { token, user } = await register('Dave');
    const res = await server.api
      .get('/api/auth/me')
      .set(authed(token))
      .expect(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.username).toBe('Dave');
  });

  test('GET /api/auth/me without token returns 401', async () => {
    await server.api.get('/api/auth/me').expect(401);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Lobby (REST)
// ═══════════════════════════════════════════════════════════════════════════════

describe('lobby (REST)', () => {

  test('create game returns gameId and waiting state', async () => {
    const { token } = await register('Host');
    const res = await server.api
      .post('/api/games')
      .set(authed(token))
      .send({ name: 'My Game', gameType: 'connect-four' })
      .expect(201);
    expect(typeof res.body.gameId).toBe('string');
    expect(res.body.state.status).toBe('waiting');
    expect(res.body.state.gameType).toBe('connect-four');
  });

  test('second player can join a waiting game', async () => {
    const { token: hostToken, user: host }    = await register('Host2');
    const { token: guestToken, user: guest }  = await register('Guest2');

    const { body: { gameId } } = await server.api
      .post('/api/games')
      .set(authed(hostToken))
      .send({ name: 'Test', gameType: 'connect-four' })
      .expect(201);

    // Host must join their own lobby to create their player entry in state.players
    // (createGame only adds the host to game_players in the DB, not to state.players).
    await server.api.post(`/api/games/${gameId}/join`).set(authed(hostToken)).expect(200);

    const joinRes = await server.api
      .post(`/api/games/${gameId}/join`)
      .set(authed(guestToken))
      .expect(200);

    const playerIds = joinRes.body.state.players.map(p => p.userId);
    expect(playerIds).toContain(host.id);
    expect(playerIds).toContain(guest.id);
  });

  test('GET /api/games lists open games', async () => {
    const { token } = await register('Lister');
    await server.api
      .post('/api/games')
      .set(authed(token))
      .send({ name: 'Listed', gameType: 'connect-four' })
      .expect(201);

    const res = await server.api
      .get('/api/games')
      .set(authed(token))
      .expect(200);
    expect(Array.isArray(res.body.games)).toBe(true);
    expect(res.body.games.some(g => g.name === 'Listed')).toBe(true);
  });

  test('GET /api/games/types returns connect-four and monopoly', async () => {
    const { token } = await register('TypeChecker');
    const res = await server.api
      .get('/api/games/types')
      .set(authed(token))
      .expect(200);
    const keys = res.body.types.map(t => t.key);
    expect(keys).toContain('connect-four');
    expect(keys).toContain('monopoly');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Full Connect Four game (sockets)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Board: 7 cols × 6 rows, win length 4.
// Scripted moves (row 5 = bottom):
//   Alice  col 0  →  board[5][0] = Alice
//   Bob    col 4  →  board[5][4] = Bob
//   Alice  col 1  →  board[5][1] = Alice
//   Bob    col 5  →  board[5][5] = Bob
//   Alice  col 2  →  board[5][2] = Alice
//   Bob    col 6  →  board[5][6] = Bob
//   Alice  col 3  →  board[5][3] = Alice  →  4-in-a-row  →  GAME OVER

describe('full Connect Four game via sockets', () => {

  // Shared across this suite's single test
  let alice, bob;          // { token, user }
  let gameId;

  beforeEach(async () => {
    alice = await register('Alice');
    bob   = await register('Bob');

    // Alice creates the game via REST
    const { body } = await server.api
      .post('/api/games')
      .set(authed(alice.token))
      .send({ name: 'CF Game', gameType: 'connect-four' })
      .expect(201);
    gameId = body.gameId;

    // Both players join via REST in order: Alice first (index 0), Bob second (index 1).
    // createGame only adds Alice to game_players in the DB, not to state.players;
    // addPlayerToLobby (called by this join route) creates the rich player record.
    await server.api.post(`/api/games/${gameId}/join`).set(authed(alice.token)).expect(200);
    await server.api.post(`/api/games/${gameId}/join`).set(authed(bob.token)).expect(200);
  });

  test('register → login → create → join → start → play → game over', async () => {
    // Connect both players' sockets
    const aliceSock = await connect(alice.token);
    const bobSock   = await connect(bob.token);

    // Both join the socket room
    await Promise.all([
      emitAck(aliceSock, 'join_game', gameId),
      emitAck(bobSock,   'join_game', gameId),
    ]);

    // Alice starts the game — everyone in the room receives game:update
    const [aliceUpdate, bobUpdate] = await Promise.all([
      waitFor(aliceSock, 'game:update'),
      waitFor(bobSock,   'game:update'),
      new Promise(resolve => { aliceSock.emit('game:start'); resolve(); }),
    ]);

    expect(aliceUpdate.state.status).toBe('playing');
    expect(bobUpdate.state.status).toBe('playing');

    // Player order: Alice is index 0 (she created/joined first), Bob is index 1
    const [playerAlice, playerBob] = aliceUpdate.state.players;
    expect(playerAlice.userId).toBe(alice.user.id);
    expect(playerBob.userId).toBe(bob.user.id);

    // ── play the scripted game ─────────────────────────────────────────────

    // Helper: current player emits dropPiece and both receive game:update
    async function drop(actorSock, otherSock, column) {
      const [actorUpd, otherUpd] = await Promise.all([
        waitFor(actorSock, 'game:update'),
        waitFor(otherSock, 'game:update'),
        new Promise(resolve => {
          actorSock.emit('game:action', { action: 'dropPiece', column });
          resolve();
        }),
      ]);
      // Both players see the same state
      expect(actorUpd.state.board).toEqual(otherUpd.state.board);
      return actorUpd; // return the update received by the actor
    }

    const m1 = await drop(aliceSock, bobSock, 0);   // Alice col 0
    expect(m1.state.status).toBe('playing');

    const m2 = await drop(bobSock, aliceSock, 4);   // Bob   col 4
    expect(m2.state.status).toBe('playing');

    const m3 = await drop(aliceSock, bobSock, 1);   // Alice col 1
    expect(m3.state.status).toBe('playing');

    const m4 = await drop(bobSock, aliceSock, 5);   // Bob   col 5
    expect(m4.state.status).toBe('playing');

    const m5 = await drop(aliceSock, bobSock, 2);   // Alice col 2
    expect(m5.state.status).toBe('playing');

    const m6 = await drop(bobSock, aliceSock, 6);   // Bob   col 6
    expect(m6.state.status).toBe('playing');

    const m7 = await drop(aliceSock, bobSock, 3);   // Alice col 3 — WIN
    expect(m7.state.status).toBe('finished');
    expect(m7.state.winner).toBe(alice.user.id);

    // GAME_OVER event must be in the last update's event list
    expect(m7.events.some(e => e.type === 'GAME_OVER')).toBe(true);

    // The winning row: bottom row (row 5), cols 0–3 should all be Alice's userId
    const board = m7.state.board;
    expect(board[5][0]).toBe(alice.user.id);
    expect(board[5][1]).toBe(alice.user.id);
    expect(board[5][2]).toBe(alice.user.id);
    expect(board[5][3]).toBe(alice.user.id);

    // GET the game from the REST API and verify persistence
    const { body: { state: persisted } } = await server.api
      .get(`/api/games/${gameId}`)
      .set(authed(alice.token))
      .expect(200);
    expect(persisted.status).toBe('finished');
    expect(persisted.winner).toBe(alice.user.id);
  });

  test('game:error is emitted for an out-of-turn action', async () => {
    const aliceSock = await connect(alice.token);
    const bobSock   = await connect(bob.token);

    await Promise.all([
      emitAck(aliceSock, 'join_game', gameId),
      emitAck(bobSock,   'join_game', gameId),
    ]);

    await Promise.all([
      waitFor(aliceSock, 'game:update'),
      waitFor(bobSock,   'game:update'),
      new Promise(resolve => { aliceSock.emit('game:start'); resolve(); }),
    ]);

    // Bob tries to act when it's Alice's turn — should receive game:error
    const errorProm = waitFor(bobSock, 'game:error');
    bobSock.emit('game:action', { action: 'dropPiece', column: 0 });
    const err = await errorProm;
    expect(typeof err.message).toBe('string');
    expect(err.message).toBeTruthy();
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Save → disconnect → reconnect → auto-resume → continue playing
// ═══════════════════════════════════════════════════════════════════════════════

describe('save, disconnect, reconnect, and resume', () => {

  test('paused game auto-resumes when host reconnects via socket', async () => {
    // ── setup ──────────────────────────────────────────────────────────────
    const charlie = await register('Charlie');
    const dave    = await register('Dave');

    const { body: { gameId } } = await server.api
      .post('/api/games')
      .set(authed(charlie.token))
      .send({ name: 'SaveTest', gameType: 'connect-four' })
      .expect(201);

    // Charlie (host) joins first so she is players[0] and goes first.
    await server.api.post(`/api/games/${gameId}/join`).set(authed(charlie.token)).expect(200);
    await server.api.post(`/api/games/${gameId}/join`).set(authed(dave.token)).expect(200);

    // Both connect and join room
    const charlSock = await connect(charlie.token);
    const daveSock  = await connect(dave.token);

    await Promise.all([
      emitAck(charlSock, 'join_game', gameId),
      emitAck(daveSock,  'join_game', gameId),
    ]);

    // Start game
    await Promise.all([
      waitFor(charlSock, 'game:update'),
      waitFor(daveSock,  'game:update'),
      new Promise(resolve => { charlSock.emit('game:start'); resolve(); }),
    ]);

    // Charlie (player 0) makes one move
    await Promise.all([
      waitFor(charlSock, 'game:update'),
      waitFor(daveSock,  'game:update'),
      new Promise(resolve => {
        charlSock.emit('game:action', { action: 'dropPiece', column: 0 });
        resolve();
      }),
    ]);

    // Dave makes one move
    await Promise.all([
      waitFor(charlSock, 'game:update'),
      waitFor(daveSock,  'game:update'),
      new Promise(resolve => {
        daveSock.emit('game:action', { action: 'dropPiece', column: 1 });
        resolve();
      }),
    ]);

    // ── save via REST (host only) ───────────────────────────────────────────
    await server.api
      .post(`/api/games/${gameId}/save`)
      .set(authed(charlie.token))
      .expect(200);

    // Verify the game is now paused
    const { body: { state: savedState } } = await server.api
      .get(`/api/games/${gameId}`)
      .set(authed(charlie.token))
      .expect(200);
    expect(savedState.status).toBe('paused');

    // ── both players disconnect ────────────────────────────────────────────
    await disconnectSocket(charlSock);
    await disconnectSocket(daveSock);
    // Remove from _openSockets (already disconnected)
    _openSockets = _openSockets.filter(s => s !== charlSock && s !== daveSock);

    // ── Charlie reconnects and rejoins the room ────────────────────────────
    const charlSock2 = await connect(charlie.token);

    // join_game on a paused game triggers auto-resume in the socket handler
    const [{ state: resumedState }] = await Promise.all([
      waitFor(charlSock2, 'game:state'),
      emitAck(charlSock2, 'join_game', gameId),
    ]);

    // Game should have automatically resumed
    expect(resumedState.status).toBe('playing');
    // Board state preserved: col 0 and col 1 have one piece each
    const board = resumedState.board;
    const charlieId = charlie.user.id;
    const daveId    = dave.user.id;
    // Bottom row: Charlie dropped in col 0, Dave in col 1
    expect(board[5][0]).toBe(charlieId);
    expect(board[5][1]).toBe(daveId);

    // ── both players back in the game — verify it is still playable ────────
    const daveSock2 = await connect(dave.token);

    // Install the listener BEFORE emitting join_game so that the PLAYER_JOINED_LOBBY
    // game:update broadcast (server → Charlie) is captured and consumed here rather
    // than racing with the drop's game:update listener below.
    const daveJoinBroadcast = waitFor(charlSock2, 'game:update');
    await emitAck(daveSock2, 'join_game', gameId);
    await daveJoinBroadcast; // discard — this is the join notification, not the drop

    // It is now Charlie's turn (player 0 — turnState from before the save was preserved)
    const [upd] = await Promise.all([
      waitFor(charlSock2, 'game:update'),
      waitFor(daveSock2,  'game:update'),
      new Promise(resolve => {
        charlSock2.emit('game:action', { action: 'dropPiece', column: 2 });
        resolve();
      }),
    ]);

    // The move succeeded (Charlie's piece in col 2)
    expect(upd.state.board[5][2]).toBe(charlieId);
    expect(upd.state.status).toBe('playing');
  });

  test('only the host can save the game', async () => {
    const eve  = await register('Eve');
    const fred = await register('Fred');

    const { body: { gameId } } = await server.api
      .post('/api/games')
      .set(authed(eve.token))
      .send({ name: 'HostSaveTest', gameType: 'connect-four' })
      .expect(201);

    await server.api.post(`/api/games/${gameId}/join`).set(authed(eve.token)).expect(200);
    await server.api.post(`/api/games/${gameId}/join`).set(authed(fred.token)).expect(200);

    const eveSock  = await connect(eve.token);
    const fredSock = await connect(fred.token);

    await Promise.all([
      emitAck(eveSock,  'join_game', gameId),
      emitAck(fredSock, 'join_game', gameId),
    ]);

    await Promise.all([
      waitFor(eveSock,  'game:update'),
      waitFor(fredSock, 'game:update'),
      new Promise(resolve => { eveSock.emit('game:start'); resolve(); }),
    ]);

    // Fred (non-host) tries to save via REST — must be rejected
    await server.api
      .post(`/api/games/${gameId}/save`)
      .set(authed(fred.token))
      .expect(400);

    // Eve (host) can save
    await server.api
      .post(`/api/games/${gameId}/save`)
      .set(authed(eve.token))
      .expect(200);
  });

});
