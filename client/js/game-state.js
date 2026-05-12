/**
 * game-state.js
 *
 * Client-side game state store.
 *
 * Holds the authoritative copy of the game state received from the server,
 * plus the current user's identity.  Other modules read from this store;
 * it is only written by the socket-client when the server pushes an update.
 *
 * Using a plain object singleton (no framework) keeps the codebase simple
 * and easy to understand.
 */

const GameState = (() => {

  let _state   = null;   // Full GameState from the server
  let _user    = null;   // { id, username } from the JWT
  let _gameId  = null;   // ID of the game currently being played / watched
  let _isHost  = false;  // True if this user created the current game

  // Listeners registered by other modules
  const _listeners = [];

  // ── write ──────────────────────────────────────────────────────────────────

  /** Replace the entire game state and notify listeners. */
  function setState(newState) {
    _state  = newState;
    _notify();
  }

  function setUser(user) {
    _user = user;
  }

  function setGameId(gameId) {
    _gameId = gameId;
  }

  function setIsHost(isHost) {
    _isHost = isHost;
  }

  function clear() {
    _state  = null;
    _gameId = null;
    _isHost = false;
  }

  // ── read ───────────────────────────────────────────────────────────────────

  function getState()  { return _state;  }
  function getUser()   { return _user;   }
  function getGameId() { return _gameId; }
  function isHost()    { return _isHost; }

  /** Return the Player object for the currently logged-in user, or null. */
  function getMyPlayer() {
    if (!_state || !_user) return null;
    return _state.players.find(p => p.userId === _user.id) || null;
  }

  /** Return the Player object for the player whose turn it is, or null. */
  function getCurrentPlayer() {
    if (!_state || !_state.turnState) return null;
    return _state.players[_state.turnState.currentPlayerIndex] || null;
  }

  /** True when it is the local user's turn. */
  function isMyTurn() {
    if (!_state || !_user) return false;
    const current = getCurrentPlayer();
    return current && current.userId === _user.id;
  }

  /** Return the board square definition for a given position (0-39). */
  function getSquare(position) {
    return _state?.config?.board?.[position] || null;
  }

  /** Return the property state for a given position. */
  function getPropertyState(position) {
    return _state?.properties?.[position] || null;
  }

  /** Return the Player who owns the property at `position`, or null. */
  function getPropertyOwner(position) {
    if (!_state) return null;
    const propState = _state.properties[position];
    if (!propState || !propState.ownerId) return null;
    return _state.players.find(p => p.userId === propState.ownerId) || null;
  }

  /** Return all properties owned by a given userId. */
  function getPropertiesOwnedBy(userId) {
    if (!_state) return [];
    return Object.entries(_state.properties)
      .filter(([, ps]) => ps.ownerId === userId)
      .map(([pos]) => Number(pos));
  }

  /** True if the current turn phase allows the given action. */
  function canDo(action) {
    if (!_state || !isMyTurn()) return false;
    const phase = _state.turnState?.phase;
    switch (action) {
      case 'rollDice':        return phase === 'pre-roll';
      case 'buyProperty':     return phase === 'buying';
      case 'declinePurchase': return phase === 'buying';
      case 'endTurn':         return phase === 'post-roll';
      case 'payJailFine':     return phase === 'pre-roll' && getMyPlayer()?.inJail;
      case 'useJailCard':     return phase === 'pre-roll' && getMyPlayer()?.inJail && getMyPlayer()?.jailCards > 0;
      // Property management can be done in pre-roll or post-roll phases
      case 'mortgage':
      case 'unmortgage':
      case 'buildHouse':
      case 'sellHouse':       return phase === 'pre-roll' || phase === 'post-roll';
      case 'trade':           return _state.config?.settings?.tradeEnabled && (phase === 'pre-roll' || phase === 'post-roll');
      default:                return false;
    }
  }

  // ── change listeners ────────────────────────────────────────────────────────

  function onChange(fn) {
    _listeners.push(fn);
  }

  function _notify() {
    for (const fn of _listeners) {
      try { fn(_state); } catch (e) { console.error('[game-state] listener error', e); }
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────

  return {
    setState, setUser, setGameId, setIsHost, clear,
    getState, getUser, getGameId, isHost,
    getMyPlayer, getCurrentPlayer, isMyTurn,
    getSquare, getPropertyState, getPropertyOwner, getPropertiesOwnedBy,
    canDo,
    onChange,
  };

})();
