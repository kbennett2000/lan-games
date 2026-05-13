'use strict';

/**
 * game-logic-interface.js
 *
 * Interface contract for game-logic modules in the LAN multiplayer framework.
 *
 * Every game module MUST export an object implementing all required methods
 * below.  The optional methods MAY be exported; the framework checks for their
 * presence before calling them.
 *
 * Design principles
 * ─────────────────
 * • Pure functions: no I/O, no global mutations, no side effects.
 * • State is a plain serialisable object (JSON-safe).
 * • Every mutating method returns a NEW state object — never mutate the input.
 * • Events are plain objects that describe what happened; the framework
 *   broadcasts them to clients and uses them for sound / animation triggers.
 * • Errors are returned in-band as `{ error: string }` rather than thrown,
 *   so the framework can relay the message to the requesting client without
 *   crashing.
 *
 * Usage
 * ─────
 * // In your game module:
 * module.exports = { initGame, createInitialPlayer, applyAction, ... };
 *
 * // Verify at startup (optional):
 * const { validateImplementation } = require('./game-logic-interface');
 * validateImplementation(require('./my-game-logic'));
 */

// ─── Type definitions (JSDoc only — no runtime objects) ──────────────────────

/**
 * @typedef {Object} User
 * @property {string} id        - Unique user ID (from the auth database).
 * @property {string} username  - Display name chosen at registration.
 * @property {*}      [rest]    - Any additional fields stored on the user row.
 */

/**
 * @typedef {Object} PlayerObject
 * A game-specific player record attached to `GameState.players`.
 * Required fields the framework itself reads:
 *
 * @property {string}  userId    - Must match `User.id`.
 * @property {string}  username  - Copy of `User.username` for display.
 * @property {boolean} active    - `false` when the player has been eliminated.
 *
 * Games may add any additional fields (money, position, hand, …).
 */

/**
 * @typedef {Object} GameEvent
 * A plain object emitted by game methods to describe something that happened.
 * The framework broadcasts every event to all clients in the room.
 *
 * @property {string} type    - Upper-snake-case identifier, e.g. `"DICE_ROLLED"`.
 * @property {Object} [data]  - Arbitrary payload; must be JSON-serialisable.
 */

/**
 * @typedef {Object} ActionResult
 * Return type of `applyAction` and `skipTurn`.
 *
 * @property {Object}      state         - New game state after the action.
 * @property {GameEvent[]} events        - Events that occurred during the action.
 * @property {string}      [error]       - Human-readable error if the action was
 *                                         rejected; when present, `state` is the
 *                                         UNCHANGED input state.
 */

/**
 * @typedef {Object} GameMetadata
 * Static descriptor returned by `getGameMetadata()`.
 *
 * @property {string}  name        - Human-readable game name, e.g. `"Monopoly"`.
 * @property {number}  minPlayers  - Minimum players required to start.
 * @property {number}  maxPlayers  - Maximum players allowed.
 * @property {string}  description - One-sentence description shown in the lobby.
 * @property {string}  [icon]      - Emoji or short string used as a visual badge.
 */

// ═════════════════════════════════════════════════════════════════════════════
//  REQUIRED METHODS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * initGame(gameId, gameName, playerList, config) → GameState
 * ──────────────────────────────────────────────────────────
 * Create the initial game state from scratch.  Called once when the host
 * clicks "Start Game" in the waiting room.
 *
 * Preconditions:
 *   • `playerList.length` is between `getGameMetadata().minPlayers` and
 *     `getGameMetadata().maxPlayers` (enforced by the framework before calling).
 *   • Each entry in `playerList` is a `PlayerObject` produced by
 *     `createInitialPlayer`.
 *   • `config` is the resolved configuration object returned by `loadConfig`
 *     (possibly with lobby overrides merged in).
 *
 * @param {string}         gameId      - Unique game ID assigned by the framework.
 * @param {string}         gameName    - Human-readable name chosen by the host.
 * @param {PlayerObject[]} playerList  - Ordered list of participating players.
 * @param {Object}         config      - Game configuration (board, rules, …).
 * @returns {Object} Initial game state.  Must be JSON-serialisable.
 *
 * @example
 * const state = GameLogic.initGame('g1', 'Friday Night', players, config);
 * // state.status === 'playing'
 * // state.players[0].userId === players[0].userId
 */

/**
 * createInitialPlayer(user) → PlayerObject
 * ─────────────────────────────────────────
 * Build a game-specific player record from a user account object.  Called for
 * every player when the game starts (including the host).
 *
 * Preconditions:
 *   • `user.id` and `user.username` are non-empty strings.
 *
 * @param {User} user - User account object from the auth system.
 * @returns {PlayerObject} A game-specific player record.  At minimum it MUST
 *   contain `{ userId: user.id, username: user.username, active: true }`.
 *   The game may add any additional fields (e.g. money, position, hand).
 *
 * @example
 * const player = GameLogic.createInitialPlayer({ id: 'u1', username: 'Alice' });
 * // player.userId === 'u1'
 * // player.username === 'Alice'
 * // player.active === true
 */

/**
 * applyAction(state, userId, action, payload) → ActionResult
 * ───────────────────────────────────────────────────────────
 * The single entry-point for all player-driven game actions.  The framework
 * receives a `game:action` socket event from a client and calls this method.
 *
 * Preconditions:
 *   • `state` is a valid, non-null game state (previously returned by
 *     `initGame` or a prior `applyAction`/`skipTurn`).
 *   • `userId` is a non-empty string identifying the acting player.
 *
 * Rejection contract:
 *   If `action` is unknown, the player is not allowed to act right now, or the
 *   `payload` is invalid, return `{ state, events: [], error: '<reason>' }`.
 *   The UNCHANGED input `state` MUST be returned alongside the error so the
 *   framework can safely ignore the call.
 *
 * @param {Object} state    - Current game state.  Do NOT mutate this object.
 * @param {string} userId   - ID of the player performing the action.
 * @param {string} action   - Action name, e.g. `"roll"`, `"buy"`, `"endTurn"`.
 * @param {Object} [payload] - Action-specific data (e.g. `{ propertyIndex: 5 }`).
 * @returns {ActionResult}
 *
 * @example
 * const result = GameLogic.applyAction(state, 'u1', 'roll', {});
 * if (result.error) {
 *   socket.emit('game:error', result.error);
 * } else {
 *   broadcastState(result.state, result.events);
 * }
 */

/**
 * skipTurn(state, userId) → ActionResult
 * ────────────────────────────────────────
 * Force-advance the turn for a player who has been idle too long.  Called by
 * the framework's turn-timer when it fires.
 *
 * The implementation MUST produce a legal state transition even if it means
 * performing the minimum required action on behalf of the player (e.g. ending
 * their turn, paying a fine, discarding a card).
 *
 * Preconditions:
 *   • `userId` is the ID of the player whose turn it currently is.
 *   • `isTurnTimerBlocked` returned `false` when the timer was started.
 *
 * @param {Object} state    - Current game state.  Do NOT mutate.
 * @param {string} userId   - ID of the player whose turn is being skipped.
 * @returns {ActionResult}  `error` should never be set; if the skip cannot
 *   produce a valid state, log and return the input state unchanged.
 *
 * @example
 * const result = GameLogic.skipTurn(state, 'u1');
 * broadcastState(result.state, result.events);
 */

/**
 * getCurrentPlayer(state) → { userId, username } | null
 * ───────────────────────────────────────────────────────
 * Return the player whose turn it is, or `null` if the game is over or
 * in a phase where no specific player is active.
 *
 * The framework uses this to:
 *   • Decide which client may send actions.
 *   • Display whose turn it is in the header.
 *   • Determine who to start the turn timer for.
 *
 * @param {Object} state - Current game state.
 * @returns {{ userId: string, username: string } | null}
 *
 * @example
 * const cur = GameLogic.getCurrentPlayer(state);
 * if (cur) io.to(gameRoom).emit('game:turn', cur.username);
 */

/**
 * isTurnTimerBlocked(state) → boolean
 * ─────────────────────────────────────
 * Return `true` when the framework should NOT start (or should cancel) the
 * turn countdown.  Use this for phases where advancing the turn automatically
 * would be wrong — e.g. an active auction where all players bid simultaneously,
 * or any modal that requires human input from multiple participants.
 *
 * @param {Object} state - Current game state.
 * @returns {boolean}
 *
 * @example
 * if (!GameLogic.isTurnTimerBlocked(state)) {
 *   startTurnTimer(gameId, currentPlayer.userId);
 * }
 */

/**
 * getValidActions(state, userId) → string[] | { [action]: Object }
 * ─────────────────────────────────────────────────────────────────
 * Return the set of actions the given player may legally perform right now.
 *
 * Two return shapes are supported:
 *   • `string[]`           — list of valid action names (simple, preferred).
 *   • `{ [action]: Object }` — map from action name to expected payload shape,
 *                               useful for richer client-side validation or UI
 *                               hint generation.
 *
 * The framework uses this to:
 *   • Disable action buttons on the client for actions that aren't valid.
 *   • Optionally validate incoming `game:action` events before calling
 *     `applyAction` (belt-and-suspenders check).
 *
 * Returning an empty array / empty object means the player has no legal moves
 * (which typically should not happen during their turn — use `skipTurn` for that).
 *
 * @param {Object} state  - Current game state.
 * @param {string} userId - ID of the player to query.
 * @returns {string[] | Object}
 *
 * @example
 * // Simple shape:
 * return ['roll', 'trade', 'manageProperty'];
 *
 * // Rich shape:
 * return {
 *   bid:  { amount: 'number' },
 *   pass: {},
 * };
 */

/**
 * getGameMetadata() → GameMetadata
 * ──────────────────────────────────
 * Return static metadata about this game type.  Called once at framework
 * startup when the module is registered, and on demand for lobby listings.
 * This method MUST be synchronous and MUST NOT depend on any game state.
 *
 * @returns {GameMetadata}
 *
 * @example
 * return {
 *   name:        'Monopoly',
 *   minPlayers:  2,
 *   maxPlayers:  8,
 *   description: 'Classic property trading board game.',
 *   icon:        '🎲',
 * };
 */

/**
 * loadConfig(configDir) → Object
 * ────────────────────────────────
 * Load and parse all configuration files from `configDir`.  The framework
 * calls this once per game-type at startup and caches the result.
 *
 * Preconditions:
 *   • `configDir` is an absolute path to a directory that exists.
 *   • Config files inside (JSON, JS, etc.) follow the game's own conventions.
 *
 * The returned object is the authoritative config used in `initGame`.  It
 * MUST be treated as immutable after this call.
 *
 * @param {string} configDir - Absolute path to the game's config directory.
 * @returns {Object} Parsed, merged configuration object.
 *
 * @example
 * const config = GameLogic.loadConfig('/app/server/config');
 */

/**
 * getConfigCopy(configDir) → Object
 * ───────────────────────────────────
 * Return a deep copy of the configuration loaded from `configDir`.  The
 * framework calls this when building a new game so that lobby overrides
 * (e.g. custom starting money) can be merged into the copy without polluting
 * the cached master config.
 *
 * Implementations MUST NOT return the same object reference as `loadConfig`;
 * the caller assumes it can mutate the returned object freely.
 *
 * @param {string} configDir - Absolute path to the game's config directory.
 * @returns {Object} A fresh deep copy of the game configuration.
 *
 * @example
 * const cfg = GameLogic.getConfigCopy('/app/server/config');
 * cfg.settings.startingMoney = lobbyOverrides.startingMoney;
 * const state = GameLogic.initGame(gameId, name, players, cfg);
 */

// ═════════════════════════════════════════════════════════════════════════════
//  OPTIONAL METHODS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * getStateForPlayer(state, userId) → Object   [OPTIONAL]
 * ────────────────────────────────────────────
 * Return a filtered view of `state` safe to send to the given player.  Use
 * this for games with hidden information (e.g. hidden hands in a card game).
 *
 * If this method is NOT exported, the framework sends the full `state` to
 * every client — appropriate for games (like Monopoly) with no hidden state.
 *
 * Preconditions:
 *   • `userId` identifies a player who is (or was) in the game.
 *   • The returned object must still be a valid, JSON-serialisable state.
 *
 * @param {Object} state  - Full canonical game state.
 * @param {string} userId - ID of the player who will receive this state.
 * @returns {Object} A player-specific view of the state.
 *
 * @example
 * // Reveal only the player's own hand:
 * return {
 *   ...state,
 *   players: state.players.map(p =>
 *     p.userId === userId ? p : { ...p, hand: p.hand.map(() => 'HIDDEN') }
 *   ),
 * };
 */

// ═════════════════════════════════════════════════════════════════════════════
//  RUNTIME VALIDATOR
// ═════════════════════════════════════════════════════════════════════════════

const REQUIRED_METHODS = [
  'initGame',
  'createInitialPlayer',
  'applyAction',
  'skipTurn',
  'getCurrentPlayer',
  'isTurnTimerBlocked',
  'getValidActions',
  'getGameMetadata',
  'loadConfig',
  'getConfigCopy',
];

const OPTIONAL_METHODS = [
  'getStateForPlayer',
];

/**
 * validateImplementation(module, options?)
 * ─────────────────────────────────────────
 * Verify that `module` exports every required method.  Throws an Error with a
 * descriptive message if any are missing.
 *
 * Call this at server startup when registering a new game type:
 *
 *   const { validateImplementation } = require('./game-logic-interface');
 *   validateImplementation(require('./monopoly/game-logic'));
 *
 * @param {Object}   module              - The game-logic module to validate.
 * @param {Object}   [options]
 * @param {string[]} [options.internalExports] - Extra exported names that are
 *   intentional (e.g. internal helpers kept public for tests).  These will not
 *   trigger an "unrecognised export" warning.
 * @throws {Error} If any required method is missing.
 */
function validateImplementation(module, options = {}) {
  const missing = REQUIRED_METHODS.filter(name => typeof module[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `GameLogic implementation is missing required method(s): ${missing.join(', ')}`
    );
  }

  const known = new Set([
    ...REQUIRED_METHODS,
    ...OPTIONAL_METHODS,
    ...(options.internalExports || []),
  ]);
  const exported = Object.keys(module).filter(k => typeof module[k] === 'function');
  const unknown  = exported.filter(k => !known.has(k));
  if (unknown.length > 0) {
    console.warn(
      `[game-logic-interface] Unrecognised exported method(s): ${unknown.join(', ')}. ` +
      'Pass them in options.internalExports to suppress this warning.'
    );
  }
}

module.exports = {
  validateImplementation,
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
};
