/**
 * jest.integration.config.js
 *
 * Separate Jest configuration for integration tests that spin up the real
 * Express + Socket.io server.  These tests are deliberately excluded from
 * "npm test" (the fast unit-test suite) to keep CI feedback loops short.
 *
 * Run with:  npm run test:integration
 */

'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/test/integration/**/*.test.js'],

  // Runs inside each worker BEFORE any require() — sets JWT_SECRET, TEST_DB_PATH,
  // BCRYPT_ROUNDS so server modules see the right values at load time.
  setupFiles: ['./test/integration/env-setup.js'],

  // Integration tests involve network I/O and bcrypt; give each test 15 s.
  testTimeout: 15_000,

  // Run sequentially so that a single in-memory SQLite DB is shared per worker
  // and the ephemeral server port is deterministic.
  maxWorkers: 1,

  // Force exit after all tests complete — the Socket.io server holds a keepalive
  // ref that would otherwise prevent Jest from exiting cleanly.
  forceExit: true,
};
