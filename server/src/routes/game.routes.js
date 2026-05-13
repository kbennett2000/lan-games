/**
 * game.routes.js
 *
 * REST endpoints for game management.  All routes require authentication.
 *
 *   GET  /api/games                          — list open / resumable games
 *   GET  /api/games/saved                    — games saved by the current user
 *   GET  /api/games/mine                     — in-progress games the user is in
 *   GET  /api/games/types                    — list registered game type keys
 *   GET  /api/games/types/:type/config       — default config for a game type
 *   POST /api/games/types/:type/config/reload — reload config from disk
 *   GET  /api/games/config/default           — alias: monopoly default config
 *   POST /api/games                          — create a new game
 *   GET  /api/games/:id                      — get game state
 *   POST /api/games/:id/join                 — join a game lobby
 *   POST /api/games/:id/start               — start a waiting game
 *   POST /api/games/:id/save                — save (pause) a game
 *   DELETE /api/games/:id                   — delete a game (host only)
 */

'use strict';

const express       = require('express');
const auth          = require('../auth');
const gameManager   = require('../game-manager');
const gameRegistry  = require('../game-registry');
const socketHandler = require('../socket-handler');

const router = express.Router();

// All game routes require a valid token
router.use(auth.requireAuth);

// ── GET /api/games ───────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    res.json({ games: gameManager.listOpenGames() });
  } catch (err) {
    console.error('[games] list error:', err);
    res.status(500).json({ error: 'Could not list games' });
  }
});

// ── GET /api/games/saved ─────────────────────────────────────────────────────

router.get('/saved', (req, res) => {
  try {
    const database = require('../database');
    res.json({ games: database.listSavedGamesForUser(req.user.sub) });
  } catch (err) {
    console.error('[games] saved list error:', err);
    res.status(500).json({ error: 'Could not list saved games' });
  }
});

// ── GET /api/games/mine ──────────────────────────────────────────────────────

router.get('/mine', (req, res) => {
  try {
    const database = require('../database');
    res.json({ games: database.listActiveGamesForUser(req.user.sub) });
  } catch (err) {
    console.error('[games] mine list error:', err);
    res.status(500).json({ error: 'Could not list active games' });
  }
});

// ── GET /api/games/types ─────────────────────────────────────────────────────
// Returns registered game type keys plus their metadata.

router.get('/types', (req, res) => {
  try {
    const types = gameRegistry.listGameTypes().map(key => ({
      key,
      ...gameRegistry.getGameLogic(key).getGameMetadata(),
    }));
    res.json({ types });
  } catch (err) {
    console.error('[games] types error:', err);
    res.status(500).json({ error: 'Could not list game types' });
  }
});

// ── GET /api/games/types/:type/config ────────────────────────────────────────
// Returns the default configuration for a specific game type.

router.get('/types/:type/config', (req, res) => {
  try {
    const logic = gameRegistry.getGameLogic(req.params.type);
    res.json({ config: logic.getConfigCopy() });
  } catch (err) {
    if (err.message.startsWith('Unknown game type')) {
      return res.status(404).json({ error: err.message });
    }
    console.error('[games] config error:', err);
    res.status(500).json({ error: 'Could not load config' });
  }
});

// ── POST /api/games/types/:type/config/reload ────────────────────────────────
// Re-read config files from disk for the given game type.

router.post('/types/:type/config/reload', (req, res) => {
  try {
    const logic  = gameRegistry.getGameLogic(req.params.type);
    const config = logic.loadConfig();
    res.json({ success: true, config });
  } catch (err) {
    if (err.message.startsWith('Unknown game type')) {
      return res.status(404).json({ error: err.message });
    }
    console.error('[games] config reload error:', err);
    res.status(500).json({ error: `Config reload failed: ${err.message}` });
  }
});

// ── GET /api/games/config/default ────────────────────────────────────────────
// Backwards-compatible alias → monopoly default config.

router.get('/config/default', (req, res) => {
  try {
    const logic = gameRegistry.getGameLogic('monopoly');
    res.json({ config: logic.getConfigCopy() });
  } catch (err) {
    console.error('[config] read error:', err);
    res.status(500).json({ error: 'Could not load config' });
  }
});

// ── POST /api/games ──────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const { name, gameType = 'monopoly', configOverrides } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Game name is required' });
  }
  if (name.length > 64) {
    return res.status(400).json({ error: 'Game name must be 64 characters or fewer' });
  }

  // Reject unknown game types with a clear 400 rather than a 500
  try {
    gameRegistry.getGameLogic(gameType);
  } catch {
    return res.status(400).json({ error: `Unknown game type: "${gameType}"` });
  }

  try {
    const { gameId, state } = gameManager.createGame(name.trim(), req.user.sub, gameType, configOverrides || {});
    socketHandler.broadcastLobbyUpdate();
    res.status(201).json({ gameId, state });
  } catch (err) {
    console.error('[games] create error:', err);
    res.status(500).json({ error: 'Could not create game' });
  }
});

// ── GET /api/games/:id ───────────────────────────────────────────────────────
// NOTE: all static routes above must be defined before this pattern.

router.get('/:id', (req, res) => {
  const state = gameManager.getGame(req.params.id);
  if (!state) return res.status(404).json({ error: 'Game not found' });
  res.json({ state });
});

// ── POST /api/games/:id/join ─────────────────────────────────────────────────

router.post('/:id/join', (req, res) => {
  const result = gameManager.addPlayerToLobby(req.params.id, { id: req.user.sub, username: req.user.username });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ state: result.state });
});

// ── POST /api/games/:id/start ────────────────────────────────────────────────

router.post('/:id/start', (req, res) => {
  const result = gameManager.startGame(req.params.id, req.user.sub);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ state: result.state });
});

// ── POST /api/games/:id/save ─────────────────────────────────────────────────

router.post('/:id/save', (req, res) => {
  const result = gameManager.saveGame(req.params.id, req.user.sub);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

// ── DELETE /api/games/:id ────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const result = gameManager.deleteGame(req.params.id, req.user.sub);
  if (result.error) return res.status(400).json({ error: result.error });
  socketHandler.broadcastLobbyUpdate();
  res.json({ success: true });
});

module.exports = router;
