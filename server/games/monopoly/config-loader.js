/**
 * config-loader.js
 *
 * Loads and validates the three JSON config files that define a Monopoly game:
 *   - board.json    — 40 board squares with property data
 *   - cards.json    — Chance and Community Chest decks
 *   - settings.json — Game settings (starting money, house limits, etc.)
 *
 * Returns a single merged "game config" object that is embedded into every
 * new game's state and can also be served to the client for display/editing.
 *
 * Because the config files can be edited by the user, this module validates
 * just enough to catch common mistakes without being overly strict.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const CONFIG_DIR = path.join(__dirname, 'config');

// ── helpers ──────────────────────────────────────────────────────────────────

function readJSON(filename) {
  const filepath = path.join(CONFIG_DIR, filename);
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to load ${filename}: ${err.message}`);
  }
}

// ── validation ───────────────────────────────────────────────────────────────

function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== 40) {
    throw new Error('board.json must be an array with exactly 40 squares');
  }
  for (let i = 0; i < board.length; i++) {
    const sq = board[i];
    if (sq.position !== i) {
      throw new Error(`board.json: square at index ${i} has position ${sq.position} (expected ${i})`);
    }
    if (!sq.type || !sq.name) {
      throw new Error(`board.json: square at position ${i} is missing type or name`);
    }
  }
}

function validateCards(cards) {
  if (!Array.isArray(cards.chance) || cards.chance.length === 0) {
    throw new Error('cards.json: chance deck must be a non-empty array');
  }
  if (!Array.isArray(cards.communityChest) || cards.communityChest.length === 0) {
    throw new Error('cards.json: communityChest deck must be a non-empty array');
  }
}

function validateSettings(settings) {
  const required = ['startingMoney', 'goSalary', 'jailFine', 'jailMaxTurns', 'maxHousesInBank', 'maxHotelsInBank'];
  for (const key of required) {
    if (typeof settings[key] !== 'number') {
      throw new Error(`settings.json: "${key}" must be a number`);
    }
  }
}

// ── derived data ─────────────────────────────────────────────────────────────

/**
 * Build a lookup map from color group name → [positions].
 * Used by the game logic to determine monopoly ownership.
 */
function buildColorGroupMap(board) {
  const map = {};
  for (const sq of board) {
    if (sq.type === 'property' && sq.colorGroup) {
      if (!map[sq.colorGroup]) map[sq.colorGroup] = [];
      map[sq.colorGroup].push(sq.position);
    }
  }
  return map;
}

/**
 * Collect positions of all railroad and utility squares.
 */
function buildTypePositions(board) {
  const railroads = [];
  const utilities = [];
  for (const sq of board) {
    if (sq.type === 'railroad') railroads.push(sq.position);
    if (sq.type === 'utility')  utilities.push(sq.position);
  }
  return { railroads, utilities };
}

// ── main loader ───────────────────────────────────────────────────────────────

let _cachedConfig = null;

/**
 * Load and cache the full game configuration.
 * Subsequent calls return the cached result without re-reading files.
 * Pass `force = true` to reload from disk (useful if config was edited at runtime).
 *
 * @param {boolean} [force=false]
 * @returns {GameConfig}
 */
function loadConfig(force = false) {
  if (_cachedConfig && !force) return _cachedConfig;

  const board    = readJSON('board.json');
  const cards    = readJSON('cards.json');
  const settings = readJSON('settings.json');

  validateBoard(board);
  validateCards(cards);
  validateSettings(settings);

  const colorGroups   = buildColorGroupMap(board);
  const typePositions = buildTypePositions(board);

  _cachedConfig = {
    board,
    cards: {
      chance:        cards.chance,
      communityChest: cards.communityChest,
    },
    settings,
    // Derived/indexed data for quick lookup during game logic
    colorGroups,
    railroadPositions: typePositions.railroads,
    utilityPositions:  typePositions.utilities,
  };

  return _cachedConfig;
}

/**
 * Return a deep copy of the config suitable for embedding in a new game
 * and for sending to clients.  The copy can be modified per-game without
 * affecting the cached master config.
 */
function getConfigCopy() {
  return JSON.parse(JSON.stringify(loadConfig()));
}

/**
 * Re-read all config files from disk and update the cache.
 * Returns the new config.
 */
function reloadConfig() {
  return loadConfig(true);
}

module.exports = { loadConfig, getConfigCopy, reloadConfig };
