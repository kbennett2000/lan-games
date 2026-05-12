/**
 * database.js
 *
 * Sets up and manages the SQLite database using better-sqlite3 (synchronous API).
 * Creates the schema on first run and exposes prepared-statement helpers used
 * by the rest of the server.  The database file is stored in server/data/.
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

// ── path setup ───────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'monopoly.db');

// Ensure the data directory exists before opening the DB
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── open database ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

// WAL mode gives significantly better write throughput for concurrent readers
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT    PRIMARY KEY,
    username     TEXT    UNIQUE NOT NULL,
    password_hash TEXT   NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'waiting',
    -- status values: waiting | playing | paused | finished
    created_by  TEXT    NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    state       TEXT    NOT NULL,   -- JSON-serialised GameState
    config      TEXT    NOT NULL    -- JSON-serialised game config
  );

  CREATE TABLE IF NOT EXISTS game_players (
    game_id    TEXT    NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id    TEXT    NOT NULL REFERENCES users(id),
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (game_id, user_id)
  );
`);

// ── prepared statements ──────────────────────────────────────────────────────

const stmts = {
  // Users
  insertUser:    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  getUserById:   db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),

  // Games
  insertGame: db.prepare(`
    INSERT INTO games (id, name, status, created_by, created_at, updated_at, state, config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateGame: db.prepare(`
    UPDATE games SET status = ?, updated_at = ?, state = ? WHERE id = ?
  `),
  getGameById: db.prepare('SELECT * FROM games WHERE id = ?'),
  listOpenGames: db.prepare(`
    SELECT g.id, g.name, g.status, g.created_at, g.created_by,
           u.username AS host_username,
           COUNT(gp.user_id) AS player_count
    FROM   games g
    JOIN   users u ON u.id = g.created_by
    LEFT JOIN game_players gp ON gp.game_id = g.id
    WHERE  g.status IN ('waiting', 'playing', 'paused')
    GROUP  BY g.id
    ORDER  BY g.created_at DESC
  `),
  listSavedGamesForUser: db.prepare(`
    SELECT g.id, g.name, g.status, g.created_at, g.updated_at, g.created_by,
           u.username AS host_username,
           (SELECT COUNT(*) FROM game_players gp2 WHERE gp2.game_id = g.id) AS player_count
    FROM   games g
    JOIN   users u           ON u.id = g.created_by
    JOIN   game_players gp   ON gp.game_id = g.id
    WHERE  gp.user_id = ?
    AND    g.status IN ('paused', 'finished')
    ORDER  BY g.updated_at DESC
  `),
  listActiveGamesForUser: db.prepare(`
    SELECT g.id, g.name, g.status, g.created_at, g.updated_at, g.created_by,
           u.username AS host_username,
           (SELECT COUNT(*) FROM game_players gp2 WHERE gp2.game_id = g.id) AS player_count
    FROM   games g
    JOIN   users u           ON u.id = g.created_by
    JOIN   game_players gp   ON gp.game_id = g.id
    WHERE  gp.user_id = ?
    AND    g.status = 'playing'
    ORDER  BY g.updated_at DESC
  `),
  deleteGame: db.prepare('DELETE FROM games WHERE id = ?'),

  // Game players
  addPlayerToGame:      db.prepare('INSERT OR IGNORE INTO game_players (game_id, user_id, joined_at) VALUES (?, ?, ?)'),
  removePlayerFromGame: db.prepare('DELETE FROM game_players WHERE game_id = ? AND user_id = ?'),
  getPlayersForGame:    db.prepare(`
    SELECT gp.user_id, u.username, gp.joined_at
    FROM   game_players gp
    JOIN   users u ON u.id = gp.user_id
    WHERE  gp.game_id = ?
    ORDER  BY gp.joined_at ASC
  `),
};

// ── public API ───────────────────────────────────────────────────────────────

module.exports = {
  // Expose the raw db connection for transactions
  db,

  // ── users ──

  createUser(id, username, passwordHash) {
    stmts.insertUser.run(id, username, passwordHash, Date.now());
  },

  getUserById(id) {
    return stmts.getUserById.get(id) || null;
  },

  getUserByUsername(username) {
    return stmts.getUserByName.get(username) || null;
  },

  // ── games ──

  createGame(id, name, createdBy, state, config) {
    const now = Date.now();
    stmts.insertGame.run(id, name, 'waiting', createdBy, now, now, JSON.stringify(state), JSON.stringify(config));
  },

  updateGame(id, status, state) {
    stmts.updateGame.run(status, Date.now(), JSON.stringify(state), id);
  },

  getGameById(id) {
    const row = stmts.getGameById.get(id);
    if (!row) return null;
    return {
      ...row,
      state:  JSON.parse(row.state),
      config: JSON.parse(row.config),
    };
  },

  listOpenGames() {
    return stmts.listOpenGames.all();
  },

  listSavedGamesForUser(userId) {
    return stmts.listSavedGamesForUser.all(userId);
  },

  listActiveGamesForUser(userId) {
    return stmts.listActiveGamesForUser.all(userId);
  },

  deleteGame(id) {
    stmts.deleteGame.run(id);
  },

  // ── game players ──

  addPlayerToGame(gameId, userId) {
    stmts.addPlayerToGame.run(gameId, userId, Date.now());
  },

  removePlayerFromGame(gameId, userId) {
    stmts.removePlayerFromGame.run(gameId, userId);
  },

  getPlayersForGame(gameId) {
    return stmts.getPlayersForGame.all(gameId);
  },
};
