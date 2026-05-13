'use strict';

/**
 * reset-db.js
 *
 * Wipes all game and user data from the SQLite database.
 *
 * Usage:
 *   node scripts/reset-db.js           -- truncates all tables (keeps schema)
 *   node scripts/reset-db.js --hard    -- deletes the database file entirely
 *   node scripts/reset-db.js --yes     -- skip confirmation prompt
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'lan-games.db');

const args = process.argv.slice(2);
const hard = args.includes('--hard');
const skip = args.includes('--yes');

if (!fs.existsSync(DB_PATH)) {
  console.log('No database file found — nothing to reset.');
  process.exit(0);
}

function confirm(question, cb) {
  if (skip) return cb();
  process.stdout.write(`${question} [y/N] `);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (data) => {
    process.stdin.destroy();
    if (data.trim().toLowerCase() === 'y') cb();
    else { console.log('Aborted.'); process.exit(0); }
  });
}

const action = hard ? 'DELETE the database file' : 'TRUNCATE all tables (users, games, game_players)';

confirm(`This will ${action}. Are you sure?`, () => {
  if (hard) {
    fs.unlinkSync(DB_PATH);
    // Also remove WAL/SHM sidecar files if present
    for (const ext of ['-wal', '-shm']) {
      const f = DB_PATH + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log(`Deleted: ${DB_PATH}`);
    console.log('The database will be recreated fresh on next server start.');
  } else {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    db.exec(`
      DELETE FROM game_players;
      DELETE FROM games;
      DELETE FROM users;
    `);
    db.close();
    console.log('All tables cleared. Schema preserved.');
    console.log(`Database: ${DB_PATH}`);
  }
});
