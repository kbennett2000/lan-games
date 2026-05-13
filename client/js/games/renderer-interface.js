/**
 * renderer-interface.js
 *
 * Formal interface contract for per-game client renderer modules.
 *
 * Every game must expose a renderer object that conforms to the GameRenderer
 * interface defined here.  Framework code (app.js, socket-client.js) looks up
 * the active renderer by state.gameType from GameRendererRegistry and interacts
 * with it exclusively through this interface — framework code must never
 * reference a specific game renderer directly.
 *
 *
 * Self-registration
 * ─────────────────
 * Each renderer IIFE registers itself at the end of its file:
 *
 *   GameRendererRegistry.register('my-game', MyGameRenderer);
 *
 * GameRendererRegistry.register() calls validateRenderer() before accepting the
 * registration, so missing-method bugs surface at page-load time.
 *
 *
 * Lifecycle
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   ┌─ entering game screen ─────────────────────────────────────────────────┐
 *   │                                                                         │
 *   │  previousRenderer?.destroy()                                            │
 *   │  renderer = GameRendererRegistry.get(state.gameType)                   │
 *   │  renderer.init(container, state, myUserId, emitAction)                 │
 *   │  renderer.update(state)   ← initial render                             │
 *   │  [framework: updatePlayerPanels, updateTurnIndicator, appendLogs]      │
 *   │                                                                         │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ game:update arrives ───────────────────────────────────────────────────┐
 *   │                                                                         │
 *   │  renderer.update(state)                                                 │
 *   │  for each event: renderer.onEvent(event, state)                        │
 *   │  [framework: updatePlayerPanels, updateTurnIndicator]                  │
 *   │  [framework handles generic events: GAME_OVER modal, conn. logs, etc.] │
 *   │                                                                         │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ game:state arrives (full sync / rejoin) ───────────────────────────────┐
 *   │                                                                         │
 *   │  renderer.update(state)   ← no events on a full sync                   │
 *   │  [framework: updatePlayerPanels, updateTurnIndicator]                  │
 *   │                                                                         │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ leaving game screen ───────────────────────────────────────────────────┐
 *   │                                                                         │
 *   │  renderer.destroy()                                                     │
 *   │                                                                         │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 *
 * Ownership split
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  RENDERER owns:
 *    • All DOM within `container` (the board area)
 *    • #action-buttons and #action-title (the action panel sidebar section)
 *    • Wiring and teardown of all game-specific UI listeners
 *
 *  FRAMEWORK owns (do not touch from renderer code):
 *    • #players-panel / .player-panel — per-player money/status sidebar
 *    • #game-turn-indicator           — whose turn it is
 *    • #chat-panel                    — chat input and message list
 *    • #game-log                      — log entries for generic events
 *    • #game-over-modal               — shown by the framework on status=finished
 *
 *
 * ACTION_REJECTED
 * ─────────────────────────────────────────────────────────────────────────────
 * emitAction is fire-and-forget.  There is no return value or promise.
 * If the server rejects an action (e.g. not your turn, invalid move), it emits
 * a game:error event.  The framework translates that into a synthetic event
 * and delivers it to the active renderer as:
 *
 *   renderer.onEvent({ type: 'ACTION_REJECTED', data: { message }, timestamp }, state)
 *
 * Renderers SHOULD handle ACTION_REJECTED to show the user why their action
 * was rejected (e.g. append a log entry, flash the action panel).
 *
 *
 * Why no `actions` object?
 * ─────────────────────────────────────────────────────────────────────────────
 * A natural first instinct is to declare something like:
 *   actions: { rollDice: () => ({}) }
 * so the framework can auto-generate buttons and keyboard shortcuts.
 *
 * In practice, game actions rarely map cleanly to a static payload factory:
 *   • Monopoly auction bidding reads a form field for the amount.
 *   • Bankruptcy requires a confirm() dialog.
 *   • Connect Four columns are individually enabled/disabled per column fullness.
 *
 * Instead, each renderer wires its own button listeners in `init`, using the
 * `emitAction` callback it receives there.
 */


// ─── Type definitions ─────────────────────────────────────────────────────────

/**
 * @callback EmitAction
 * Send a game action to the server.  The call is fire-and-forget — there is no
 * return value and no promise.  If the server accepts the action it will push an
 * updated state via game:update.  If the server rejects the action it will
 * deliver the reason via the synthetic ACTION_REJECTED event in onEvent.
 *
 * The server routes this through the game-logic module's
 * `applyAction(state, userId, action, payload)`.
 *
 * @param {string} action   - Action name understood by the server-side game logic,
 *                            e.g. `'rollDice'`, `'dropPiece'`, `'endTurn'`.
 * @param {object} [payload] - Action-specific data; must be JSON-serialisable.
 *                             Omit or pass `{}` when the action needs no parameters.
 * @returns {void}
 *
 * @example
 * emitAction('dropPiece', { column: 3 });
 * emitAction('rollDice');
 */

/**
 * @typedef {object} GameState
 * The full game state object sent by the server.  The framework treats this as
 * an opaque blob; the renderer is responsible for reading whatever game-specific
 * fields it needs.
 *
 * Fields the framework itself reads (renderer must not remove or rename them):
 * @property {string}   gameType                - Registry key, e.g. `'monopoly'`.
 * @property {string}   status                  - `'waiting'|'playing'|'paused'|'finished'`.
 * @property {string|null} [winner]             - UserId of winner, null for draw, undefined if not applicable.
 * @property {object[]} players                 - Array of player objects.
 * @property {string}   players[].userId        - Unique player identifier.
 * @property {string}   players[].username      - Display name.
 * @property {boolean}  [players[].isBankrupt]  - Framework reads for Monopoly winner fallback.
 */

/**
 * @typedef {object} GameEvent
 * An event emitted by the server-side game logic during an action, or a
 * synthetic event injected by the framework (e.g. ACTION_REJECTED).
 *
 * @property {string} type      - Upper-snake-case identifier, e.g. `'PIECE_DROPPED'`.
 * @property {object} [data]    - Event-specific payload.
 * @property {number} timestamp - Unix millisecond timestamp.
 */


// ═════════════════════════════════════════════════════════════════════════════
//  REQUIRED METHODS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @function init
 * @description
 * Called once when the local player enters the game screen (on first join and
 * on rejoin after page refresh).  The framework guarantees that:
 *   1. The previous renderer's destroy() has already been called (or there was
 *      no previous renderer).
 *   2. The container is in a "neutral" state: #board is visible,
 *      any game-specific wrappers are hidden and empty.
 *
 * init is responsible for:
 *   • Building the game's DOM structure inside or adjacent to `container`.
 *   • Wiring all game-specific UI event listeners (button clicks, column drops,
 *     property click handlers, etc.).
 *   • Storing `myUserId` and `emitAction` for use in subsequent update() calls.
 *
 * init MUST NOT perform a visual state render — the framework calls update(state)
 * immediately after init returns.  This keeps the initial render path identical
 * to the per-update path and avoids rendering the state twice.
 *
 * myUserId lifecycle: myUserId is fixed for the entire lifetime of this renderer
 * instance.  If the local viewer's identity must change (e.g. spectator mode or
 * an account switch), the framework will call destroy() and then init() with the
 * new value — it will never mutate the identity mid-session.
 *
 * @param {HTMLElement} container  - The .board-wrapper element.  The renderer
 *                                   may freely mutate its children.
 * @param {GameState}   state      - Full initial game state from the server.
 *                                   Use config fields (e.g. board dimensions)
 *                                   for one-time DOM setup; do not render here.
 * @param {string}      myUserId   - The local player's userId.  Constant for the
 *                                   lifetime of this renderer instance.
 * @param {EmitAction}  emitAction - Fire-and-forget function to send an action to
 *                                   the server.  Store it and use it in listeners.
 * @returns {void}
 *
 * @example
 * function init(container, state, myUserId, emitAction) {
 *   _myUserId = myUserId;
 *   _emit     = emitAction;
 *   const { boardWidth } = state.config.settings;
 *   // … build DOM …
 *   colBtn.addEventListener('click', () => _emit('dropPiece', { column: 0 }));
 * }
 */

/**
 * @function update
 * @description
 * Called on every state push from the server (game:state and game:update events)
 * and once immediately after init().
 *
 * update is responsible for synchronising the full visual state of the game:
 *   1. The board (piece positions, property ownership, dice, etc.)
 *   2. The action panel (#action-title, #action-buttons): which actions are
 *      available, which are disabled, and what the sidebar title says.
 *
 * IDEMPOTENCY CONTRACT — this is strictly enforced:
 *   Calling update(state) twice with the same state object must produce
 *   identical DOM and have no observable side effects.  Specifically:
 *     • No replayed animations — animations belong in onEvent, not update.
 *     • No replayed sounds — sounds belong in onEvent, not update.
 *     • No rebound listeners — listeners must be bound once in init() or replaced
 *       wholesale (innerHTML = ...) rather than appended on each call.
 *     • No appended-without-checking elements — always clear then rebuild, or
 *       diff, rather than blindly appending.
 *   If an effect would replay when the server sends a reconnect-resync, it
 *   belongs in onEvent, not update.
 *
 * Error handling: if update encounters unexpected or malformed state, log the
 * error and leave the DOM in its last-good state — do not throw, do not crash.
 *
 * The renderer knows myUserId from init(), so update() only needs state.
 *
 * @param {GameState} state - Full game state from the server.
 * @returns {void}
 *
 * @example
 * function update(state) {
 *   _paintBoard(state.board);
 *   const cur = state.players[state.turnState.currentPlayerIndex];
 *   const isMyTurn = cur?.userId === _myUserId;
 *   document.getElementById('action-title').textContent =
 *     isMyTurn ? 'Your turn' : `Waiting for ${cur?.username}…`;
 *   _dropButtons.forEach((btn, c) =>
 *     btn.disabled = !isMyTurn || state.board[0][c] !== null
 *   );
 * }
 */

/**
 * @function destroy
 * @description
 * Called when the local player leaves the game screen (quit, back-to-lobby,
 * or before a new renderer is init()-ed for a different game type).
 *
 * destroy must:
 *   • Undo all DOM changes made in init() and any subsequent update() calls,
 *     leaving the container in the neutral state described under init().
 *   • Remove all event listeners registered by this renderer instance to
 *     prevent memory leaks and ghost handlers on future game screens.
 *   • Clear all internal state (stored refs, callbacks, myUserId, emitAction).
 *
 * After destroy() returns the framework considers this renderer instance invalid
 * and will not call any further methods on it.
 *
 * Error handling: destroy should not throw.  If cleanup fails, log and continue.
 *
 * @returns {void}
 *
 * @example
 * function destroy() {
 *   const wrapper = document.getElementById('my-game-wrapper');
 *   if (wrapper) { wrapper.style.display = 'none'; wrapper.innerHTML = ''; }
 *   document.getElementById('board').style.display = '';
 *   _emit      = null;
 *   _myUserId  = null;
 * }
 */


// ═════════════════════════════════════════════════════════════════════════════
//  OPTIONAL METHODS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @function onEvent  [OPTIONAL]
 * @description
 * Called for each event in the events array of a game:update message, in order,
 * AFTER update(state) has already been called for the same update batch.
 *
 * Use onEvent for one-shot side-effects that update() cannot express because
 * they are not visible in the persistent state snapshot:
 *   • Sound effects (dice roll, piece drop, win fanfare)
 *   • Flash/animation on a specific cell or board square
 *   • Log entries for game-specific events
 *   • Displaying ACTION_REJECTED feedback to the user
 *
 * The framework delivers a synthetic ACTION_REJECTED event here whenever the
 * server emits game:error:
 *   { type: 'ACTION_REJECTED', data: { message: string }, timestamp: number }
 *
 * The framework also handles a fixed set of generic events independently
 * (GAME_OVER modal, PLAYER_CONNECTED / PLAYER_DISCONNECTED / TURN_SKIPPED log
 * entries).  The renderer will still receive these events via onEvent and may
 * add game-specific handling on top (e.g. a game-specific GAME_OVER log line).
 *
 * Implementations MUST silently ignore event types they do not recognise.
 *
 * If this method is absent, the framework skips calling it (no error).
 *
 * @param {GameEvent} event - The event to handle.
 * @param {GameState} state - The full state at the time the event batch arrived.
 * @returns {void}
 *
 * @example
 * function onEvent(event, state) {
 *   switch (event.type) {
 *     case 'ACTION_REJECTED':
 *       UIManager.appendLog(`⚠ ${event.data.message}`, 'info');
 *       _flashActionPanel();
 *       break;
 *     case 'PIECE_DROPPED':
 *       SoundManager.playDrop();
 *       break;
 *     case 'GAME_OVER':
 *       UIManager.appendLog(
 *         event.data.winner ? `🏆 ${event.data.winner} wins!` : "🤝 It's a draw!", 'game'
 *       );
 *       break;
 *   }
 * }
 */


// ═════════════════════════════════════════════════════════════════════════════
//  RUNTIME VALIDATOR
// ═════════════════════════════════════════════════════════════════════════════

const RENDERER_REQUIRED_METHODS = ['init', 'update', 'destroy'];
const RENDERER_OPTIONAL_METHODS = ['onEvent'];

/**
 * validateRenderer(renderer, name)
 * ──────────────────────────────────
 * Verify that `renderer` implements every required method as a function.
 * Throws with a descriptive message if any are missing.
 * Warns (does not throw) if unrecognised methods are present.
 *
 * Called automatically by GameRendererRegistry.register().
 *
 * @param {object} renderer - The renderer object to validate.
 * @param {string} name     - Display name used in error messages, typically the
 *                            game type key such as `'connect-four'`.
 * @throws {Error} If renderer is not an object, or any required method is absent.
 *
 * @example
 * validateRenderer(ConnectFourRenderer, 'connect-four');
 */
function validateRenderer(renderer, name) {
  if (!renderer || typeof renderer !== 'object') {
    throw new Error(`[renderer-interface] "${name}" renderer must be a plain object.`);
  }

  const missing = RENDERER_REQUIRED_METHODS.filter(m => typeof renderer[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `[renderer-interface] "${name}" renderer is missing required method(s): ${missing.join(', ')}`
    );
  }

  const known = new Set([...RENDERER_REQUIRED_METHODS, ...RENDERER_OPTIONAL_METHODS]);
  const extra = Object.keys(renderer).filter(k => typeof renderer[k] === 'function' && !known.has(k));
  if (extra.length > 0) {
    console.warn(
      `[renderer-interface] "${name}" renderer exports unrecognised method(s): ${extra.join(', ')}. ` +
      'These will not be called by the framework.'
    );
  }
}

// Dual-mode export: works as a browser global and as a Node/Jest module.
if (typeof module !== 'undefined') {
  module.exports = { validateRenderer, RENDERER_REQUIRED_METHODS, RENDERER_OPTIONAL_METHODS };
}
