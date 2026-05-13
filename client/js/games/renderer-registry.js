/**
 * renderer-registry.js
 *
 * Runtime registry for per-game client renderers.
 *
 * Each game renderer self-registers at the bottom of its IIFE:
 *
 *   GameRendererRegistry.register('my-game', MyGameRenderer);
 *
 * register() calls validateRenderer() before accepting the registration,
 * so missing-method bugs surface at page-load time.
 *
 * The framework (app.js, socket-client.js) uses the registry to:
 *   - Look up a renderer by gameType: GameRendererRegistry.get('connect-four')
 *   - Track the currently active renderer: setActive / getActive / clearActive
 *
 * Framework code must never reference a specific renderer global directly;
 * always go through this registry.
 */

'use strict';

const GameRendererRegistry = (() => {

  const _renderers = new Map();
  let   _active    = null;

  /**
   * Register a renderer for a game type.
   * Validates the renderer against the interface contract before storing it.
   *
   * @param {string} gameType - Registry key, e.g. 'connect-four'.
   * @param {object} renderer - Object implementing the GameRenderer interface.
   */
  function register(gameType, renderer) {
    validateRenderer(renderer, gameType); // validateRenderer is loaded from renderer-interface.js
    _renderers.set(gameType, renderer);
    console.log(`[renderer-registry] Registered renderer for "${gameType}"`);
  }

  /**
   * Get the renderer for a game type.
   * Returns null if no renderer is registered for the given type.
   *
   * @param {string} gameType
   * @returns {object|null}
   */
  function get(gameType) {
    return _renderers.get(gameType) || null;
  }

  /**
   * Mark a renderer instance as the currently active one.
   * Called by the framework after init() is invoked.
   *
   * @param {object} renderer
   */
  function setActive(renderer) {
    _active = renderer;
  }

  /**
   * Return the currently active renderer, or null if none is active.
   * Used by socket-client.js to route events to the right renderer.
   *
   * @returns {object|null}
   */
  function getActive() {
    return _active;
  }

  /**
   * Clear the active renderer pointer (without calling destroy).
   * Normally the framework calls renderer.destroy() first, then clearActive().
   */
  function clearActive() {
    _active = null;
  }

  return { register, get, setActive, getActive, clearActive };

})();

// Dual-mode export: works as a browser global and as a Node/Jest module.
if (typeof module !== 'undefined') {
  module.exports = { GameRendererRegistry };
}
