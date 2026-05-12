/**
 * game.routes.js
 *
 * REST endpoints for game management.  All routes require authentication.
 *
 *   GET  /api/games              — list open / resumable games
 *   POST /api/games              — create a new game
 *   GET  /api/games/:id          — get game state
 *   POST /api/games/:id/join     — join a game lobby
 *   POST /api/games/:id/start    — start a waiting game
 *   POST /api/games/:id/save     — save (pause) a game
 *   GET  /api/config             — get the default game configuration
 *   GET  /api/games/saved        — list games saved by the current user
 */

'use strict';

const express        = require('express');
const auth           = require('../auth');
const gameManager    = require('../game-manager');
const socketHandler  = require('../socket-handler');
const { getConfigCopy, reloadConfig } = require('../config-loader');

const router = express.Router();

// All game routes require a valid token
router.use(auth.requireAuth);

// ── GET /api/games ───────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const games = gameManager.listOpenGames();
    res.json({ games });
  } catch (err) {
    console.error('[games] list error:', err);
    res.status(500).json({ error: 'Could not list games' });
  }
});

// ── GET /api/games/saved ─────────────────────────────────────────────────────

router.get('/saved', (req, res) => {
  try {
    const database = require('../database');
    const games    = database.listSavedGamesForUser(req.user.sub);
    res.json({ games });
  } catch (err) {
    console.error('[games] saved list error:', err);
    res.status(500).json({ error: 'Could not list saved games' });
  }
});

// ── GET /api/games/mine ──────────────────────────────────────────────────────
// Returns in-progress games the current user is a player in.

router.get('/mine', (req, res) => {
  try {
    const database = require('../database');
    const games    = database.listActiveGamesForUser(req.user.sub);
    res.json({ games });
  } catch (err) {
    console.error('[games] mine list error:', err);
    res.status(500).json({ error: 'Could not list active games' });
  }
});

// ── POST /api/games ──────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const { name, configOverrides } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Game name is required' });
  }
  if (name.length > 64) {
    return res.status(400).json({ error: 'Game name must be 64 characters or fewer' });
  }

  try {
    const { gameId, state } = gameManager.createGame(name.trim(), req.user.sub, configOverrides || {});
    socketHandler.broadcastLobbyUpdate();
    res.status(201).json({ gameId, state });
  } catch (err) {
    console.error('[games] create error:', err);
    res.status(500).json({ error: 'Could not create game' });
  }
});

// ── GET /api/games/:id ───────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const state = gameManager.getGame(req.params.id);
  if (!state) return res.status(404).json({ error: 'Game not found' });
  res.json({ state });
});

// ── POST /api/games/:id/join ─────────────────────────────────────────────────

router.post('/:id/join', (req, res) => {
  const result = gameManager.addPlayerToLobby(req.params.id, req.user.sub, req.user.username);
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

// ── GET /api/config ──────────────────────────────────────────────────────────

router.get('/config/default', (req, res) => {
  try {
    res.json({ config: getConfigCopy() });
  } catch (err) {
    console.error('[config] read error:', err);
    res.status(500).json({ error: 'Could not load config' });
  }
});

// ── POST /api/config/reload ──────────────────────────────────────────────────
// Re-read config files from disk.  Useful after manually editing the JSON files.

router.post('/config/reload', (req, res) => {
  try {
    const config = reloadConfig();
    res.json({ success: true, config });
  } catch (err) {
    console.error('[config] reload error:', err);
    res.status(500).json({ error: `Config reload failed: ${err.message}` });
  }
});

module.exports = router;
