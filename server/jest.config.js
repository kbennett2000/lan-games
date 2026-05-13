/**
 * jest.config.js — default (unit-test) Jest configuration.
 *
 * Only matches *.test.js files that live directly in test/ — not in any
 * subdirectory — so test/integration/ is excluded automatically.
 *
 * Integration tests have their own config: jest.integration.config.js
 * Run them with: npm run test:integration
 */

'use strict';

module.exports = {
  testEnvironment: 'node',
  // Match test files that are direct children of test/ (depth 1 only).
  // The client-renderer-interface test uses the @jest-environment jsdom
  // pragma which overrides this setting for that file.
  testMatch: ['**/test/*.test.js'],
};
