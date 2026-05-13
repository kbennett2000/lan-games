/**
 * api.js
 *
 * Thin wrapper around fetch() for all REST calls to the server.
 * All methods return parsed JSON or throw an Error with a human-readable message.
 *
 * The auth token is stored in localStorage and automatically attached to
 * every request via the Authorization header.
 */

const API = (() => {

  // ── token storage ──────────────────────────────────────────────────────────

  function getToken()       { return localStorage.getItem('monopoly_token'); }
  function setToken(token)  { localStorage.setItem('monopoly_token', token); }
  function clearToken()     { localStorage.removeItem('monopoly_token'); }

  // ── base fetch helper ──────────────────────────────────────────────────────

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token   = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({ error: 'Invalid server response' }));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    return data;
  }

  const get    = (path)        => request('GET',  path);
  const post   = (path, body)  => request('POST', path, body);

  // ── auth ───────────────────────────────────────────────────────────────────

  async function register(username, password) {
    const data = await post('/api/auth/register', { username, password });
    setToken(data.token);
    return data.user;
  }

  async function login(username, password) {
    const data = await post('/api/auth/login', { username, password });
    setToken(data.token);
    return data.user;
  }

  function logout() {
    clearToken();
  }

  async function getMe() {
    return get('/api/auth/me');
  }

  // ── games ──────────────────────────────────────────────────────────────────

  async function listGames() {
    return get('/api/games');
  }

  async function listSavedGames() {
    return get('/api/games/saved');
  }

  async function listMyActiveGames() {
    return get('/api/games/mine');
  }

  async function deleteGame(gameId) {
    return request('DELETE', `/api/games/${gameId}`);
  }

  async function createGame(name, gameType = 'monopoly', configOverrides = {}) {
    return post('/api/games', { name, gameType, configOverrides });
  }

  async function joinGame(gameId) {
    return post(`/api/games/${gameId}/join`);
  }

  async function getGame(gameId) {
    return get(`/api/games/${gameId}`);
  }

  async function startGame(gameId) {
    return post(`/api/games/${gameId}/start`);
  }

  async function saveGame(gameId) {
    return post(`/api/games/${gameId}/save`);
  }

  // ── game types & config ────────────────────────────────────────────────────

  async function getGameTypes() {
    return get('/api/games/types');
  }

  async function getGameTypeConfig(gameType) {
    return get(`/api/games/types/${encodeURIComponent(gameType)}/config`);
  }

  async function getDefaultConfig() {
    return get('/api/games/config/default');
  }

  // ── token helpers for use by socket-client ─────────────────────────────────

  return {
    getToken, setToken, clearToken,
    register, login, logout, getMe,
    listGames, listSavedGames, listMyActiveGames, deleteGame,
    createGame, joinGame, getGame, startGame, saveGame,
    getGameTypes, getGameTypeConfig, getDefaultConfig,
  };

})();
