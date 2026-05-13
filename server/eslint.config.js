'use strict';

const js = require('@eslint/js');
const n  = require('eslint-plugin-n');

module.exports = [
  // ── ignore generated / runtime dirs ─────────────────────────────────────────
  { ignores: ['node_modules/**', 'data/**'] },

  // ── baseline rules ───────────────────────────────────────────────────────────
  js.configs.recommended,
  n.configs['flat/recommended'],

  {
    languageOptions: {
      ecmaVersion:   2022,
      sourceType:    'commonjs',
    },
    rules: {
      // Server code logs freely; suppress the default warn.
      'no-console': 'off',

      // This is a private application — publish-check rules add noise.
      'n/no-unpublished-require': 'off',

      // Allow _-prefixed names as the conventional "intentionally unused" marker.
      'no-unused-vars': ['error', {
        vars:               'all',
        args:               'after-used',
        argsIgnorePattern:  '^_',
        varsIgnorePattern:  '^_',
      }],
    },
  },

  // ── entry point + CLI scripts — process.exit() is legitimate here ─────────
  {
    files: ['src/index.js', 'scripts/**/*.js'],
    rules: {
      'n/no-process-exit': 'off',
    },
  },

  // ── jsdom test — browser globals ─────────────────────────────────────────
  {
    files: ['test/client-renderer-interface.test.js'],
    languageOptions: {
      globals: {
        document:  'readonly',
        window:    'readonly',
        navigator: 'readonly',
      },
    },
  },

  // ── test files — Jest globals ─────────────────────────────────────────────
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        afterAll:   'readonly',
        afterEach:  'readonly',
        beforeAll:  'readonly',
        beforeEach: 'readonly',
        describe:   'readonly',
        expect:     'readonly',
        it:         'readonly',
        jest:       'readonly',
        test:       'readonly',
      },
    },
  },
];
