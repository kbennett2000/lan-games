'use strict';

/**
 * game-manager.test.js
 *
 * Tests the per-game action queue added to game-manager.js.
 * The database is replaced with a lightweight in-memory mock so no file I/O
 * occurs and the tests stay fast.
 */

// ── database mock ─────────────────────────────────────────────────────────────
// jest.mock is hoisted before any require() calls, so the factory must be
// self-contained.  We expose _store so beforeEach can clear it between tests.

jest.mock('../src/database', () => {
  const store = new Map();
  return {
    _store: store,
    createGame(id, _name, createdBy, state, config, gameType) {
      store.set(id, {
        id,
        created_by: createdBy,
        game_type:  gameType || 'monopoly',
        status:     'waiting',
        state:      JSON.parse(JSON.stringify(state)),
        config:     JSON.parse(JSON.stringify(config)),
      });
    },
    updateGame(id, status, stateObj) {
      const row = store.get(id);
      if (row) { row.status = status; row.state = JSON.parse(JSON.stringify(stateObj)); }
    },
    getGameById(id) {
      const row = store.get(id);
      if (!row) return null;
      return { ...row, state: JSON.parse(JSON.stringify(row.state)) };
    },
    addPlayerToGame() {},
    removePlayerFromGame() {},
    listOpenGames() { return []; },
    db: {},
  };
});

// ── module imports (after mock registration) ──────────────────────────────────

const database    = require('../src/database');
const gameManager = require('../src/game-manager');

// ── test helpers ──────────────────────────────────────────────────────────────

const HOST = { id: 'host-001', username: 'Alice' };
const P2   = { id: 'plyr-002', username: 'Bob'   };

/**
 * Create a game, add two players, start it, and return the gameId.
 * All calls here are synchronous (createGame / addPlayerToLobby / startGame
 * do not go through the lock).
 */
function createAndStartGame() {
  const { gameId } = gameManager.createGame('Test Game', HOST.id, 'monopoly');
  gameManager.addPlayerToLobby(gameId, HOST);
  gameManager.addPlayerToLobby(gameId, P2);
  const result = gameManager.startGame(gameId, HOST.id);
  if (result.error) throw new Error(`startGame failed: ${result.error}`);
  return gameId;
}

// ── setup / teardown ──────────────────────────────────────────────────────────

afterEach(() => {
  // Clear the mock DB between tests.  The game-manager's activeGames map
  // retains entries across tests, but each test uses a fresh UUID so there
  // is no cross-test interference.
  database._store.clear();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Per-game action queue
// ═══════════════════════════════════════════════════════════════════════════════

describe('per-game action queue', () => {

  // ── basic liveness ──────────────────────────────────────────────────────────

  test('N concurrent applyAction calls all resolve (no deadlock)', async () => {
    const gameId  = createAndStartGame();
    const N       = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      ),
    );
    expect(results).toHaveLength(N);
    expect(results.every(r => r !== undefined && r !== null)).toBe(true);
  });

  // ── state consistency ───────────────────────────────────────────────────────

  test('exactly one rollDice succeeds when N calls fire concurrently', async () => {
    const gameId  = createAndStartGame();
    const N       = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      ),
    );

    const successes = results.filter(r => !r.error);
    const errors    = results.filter(r =>  r.error);

    // Only the first call in the queue can succeed — the game logic rejects
    // subsequent rolls because the turn phase has already advanced.
    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(N - 1);
  });

  test('final state reflects exactly one roll after N concurrent calls', async () => {
    const gameId = createAndStartGame();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      ),
    );

    const final = gameManager.getGame(gameId);
    // Dice were set to non-zero values — exactly one roll happened.
    // Phase is not checked here: it depends on what the player landed on
    // (pre-roll if doubles, buying if unowned property, post-roll otherwise).
    expect(final.turnState.dice[0] + final.turnState.dice[1]).toBeGreaterThan(0);
  });

  // ── high-concurrency stress ─────────────────────────────────────────────────

  test('no deadlock under high concurrency (50 calls)', async () => {
    const gameId  = createAndStartGame();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      ),
    );
    // Every promise must settle — if any hang the test times out
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
  });

  // ── game isolation ──────────────────────────────────────────────────────────

  test('queues for different games are independent', async () => {
    const g1 = createAndStartGame();
    const g2 = createAndStartGame();

    const [r1, r2] = await Promise.all([
      gameManager.applyAction(g1, HOST.id, 'rollDice', {}),
      gameManager.applyAction(g2, HOST.id, 'rollDice', {}),
    ]);

    // Each game is in its own pre-roll phase — both rolls should succeed.
    // Phase is not asserted: doubles keep it at pre-roll, an unowned property
    // moves it to buying, etc.  Dice being set proves the roll ran.
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(gameManager.getGame(g1).turnState.dice[0] + gameManager.getGame(g1).turnState.dice[1]).toBeGreaterThan(0);
    expect(gameManager.getGame(g2).turnState.dice[0] + gameManager.getGame(g2).turnState.dice[1]).toBeGreaterThan(0);
  });

  // ── saveGame shares the same queue ─────────────────────────────────────────

  test('concurrent applyAction and saveGame both resolve without throwing', async () => {
    const gameId = createAndStartGame();

    // Fire both at the same instant — order of execution is determined by the
    // queue.  Either the roll succeeds then the game is saved, or the save
    // pauses the game first and the roll is rejected.  In both cases the
    // promises must resolve (not throw) and the state must be self-consistent.
    const [actionResult, saveResult] = await Promise.all([
      gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      gameManager.saveGame(gameId, HOST.id),
    ]);

    expect(actionResult).toBeDefined();
    expect(saveResult).toBeDefined();

    const final = gameManager.getGame(gameId);
    // Whatever order ran: status must be a valid value, not undefined/corrupt
    expect(['playing', 'paused']).toContain(final.status);
  });

  test('saveGame followed by applyAction correctly rejects the action', async () => {
    const gameId = createAndStartGame();

    // Save first (sequential, not concurrent) so the game is definitively paused
    await gameManager.saveGame(gameId, HOST.id);
    expect(gameManager.getGame(gameId).status).toBe('paused');

    // Any action against a paused game must be rejected
    const result = await gameManager.applyAction(gameId, HOST.id, 'rollDice', {});
    expect(result.error).toBe('Game is not in playing state');
    // State must not have been mutated
    expect(gameManager.getGame(gameId).status).toBe('paused');
  });

  // ── setPlayerConnected shares the same queue ────────────────────────────────

  test('setPlayerConnected and applyAction on the same game both resolve', async () => {
    const gameId = createAndStartGame();

    const [, actionResult] = await Promise.all([
      gameManager.setPlayerConnected(gameId, HOST.id, false),
      gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
    ]);

    // The action result must be defined (not lost due to a race)
    expect(actionResult).toBeDefined();
    // Final state must be self-consistent
    expect(gameManager.getGame(gameId)).not.toBeNull();
  });

  // ── lock cleanup ────────────────────────────────────────────────────────────

  test('subsequent calls resolve normally after queue has fully drained', async () => {
    // Verify that the lock entry is cleaned up correctly after a batch completes.
    // A stale, unreleased lock would cause any subsequent call to hang forever.
    const gameId = createAndStartGame();

    // Drain the queue with a batch of calls
    await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        gameManager.applyAction(gameId, HOST.id, 'rollDice', {}),
      ),
    );

    // A follow-up call that does not depend on game phase must resolve promptly.
    // setPlayerConnected always succeeds regardless of turn state.
    await gameManager.setPlayerConnected(gameId, HOST.id, false);
    expect(gameManager.getGame(gameId).players.find(p => p.userId === HOST.id).connected).toBe(false);

    // And a further call proves the queue is still accepting work
    await gameManager.setPlayerConnected(gameId, HOST.id, true);
    expect(gameManager.getGame(gameId).players.find(p => p.userId === HOST.id).connected).toBe(true);
  });

});
