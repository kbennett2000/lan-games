/**
 * env-setup.js
 *
 * Runs inside each Jest worker before any test module is loaded (via the
 * "setupFiles" config option).  Sets environment variables that server modules
 * read at require() time, so they must be in place before any require() runs.
 */

'use strict';

// Use an in-memory SQLite database so integration tests leave no files behind.
process.env.TEST_DB_PATH   = ':memory:';

// A deterministic secret — never use this outside of tests.
process.env.JWT_SECRET     = 'integration-test-secret-do-not-use-in-production';

// bcrypt cost factor 4 is the minimum and hashes in < 5 ms; production uses 12.
process.env.BCRYPT_ROUNDS  = '4';

// Suppress the "bound to all interfaces" startup warning.
process.env.NODE_ENV       = 'test';
