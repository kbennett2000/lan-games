'use strict';

/**
 * game-registry.js
 *
 * Central registry of game-logic modules.  Add a new entry here to make a
 * second game type available in the framework.
 *
 * Each value must implement the GameLogic interface defined in
 * game-logic-interface.js.
 */

const registry = {
  monopoly:      require('../games/monopoly/game-logic'),
  'connect-four': require('../games/connect-four/game-logic'),
};

/**
 * Return the game-logic module for the given game type.
 * @param {string} gameType  e.g. 'monopoly'
 * @throws {Error} if the game type is not registered
 */
function getGameLogic(gameType) {
  const logic = registry[gameType];
  if (!logic) throw new Error(`Unknown game type: "${gameType}"`);
  return logic;
}

/** Return all registered game type keys. */
function listGameTypes() {
  return Object.keys(registry);
}

module.exports = { getGameLogic, listGameTypes };
