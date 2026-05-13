/**
 * @jest-environment jsdom
 *
 * Tests for the GameRenderer interface contract defined in
 * client/js/games/renderer-interface.js.
 *
 * Run with:  npm test -- client-renderer-interface
 */

'use strict';

const {
  validateRenderer,
  RENDERER_REQUIRED_METHODS,
  RENDERER_OPTIONAL_METHODS,
} = require('../../client/js/games/renderer-interface');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeContainer() {
  const el = document.createElement('div');
  el.id = 'board-wrapper';
  document.body.appendChild(el);
  return el;
}

function makeState(overrides = {}) {
  return {
    gameType: 'test-game',
    status:   'playing',
    players:  [],
    ...overrides,
  };
}

/** A renderer stub that does nothing — the minimal valid implementation. */
const noopRenderer = {
  init:    () => {},
  update:  () => {},
  destroy: () => {},
};

// ─────────────────────────────────────────────────────────────────────────────
//  validateRenderer — contract enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('validateRenderer', () => {
  test('accepts a complete no-op renderer', () => {
    expect(() => validateRenderer(noopRenderer, 'test-game')).not.toThrow();
  });

  test('accepts a renderer that includes the optional onEvent method', () => {
    const withEvent = { ...noopRenderer, onEvent: () => {} };
    expect(() => validateRenderer(withEvent, 'test-game')).not.toThrow();
  });

  test('throws when renderer is null', () => {
    expect(() => validateRenderer(null, 'test-game')).toThrow(/must be a plain object/i);
  });

  test('throws when renderer is not an object', () => {
    expect(() => validateRenderer('string', 'test-game')).toThrow(/must be a plain object/i);
  });

  for (const method of RENDERER_REQUIRED_METHODS) {
    test(`throws when required method "${method}" is missing`, () => {
      const incomplete = { ...noopRenderer };
      delete incomplete[method];
      expect(() => validateRenderer(incomplete, 'test-game')).toThrow(
        new RegExp(method)
      );
    });

    test(`throws when required method "${method}" is not a function`, () => {
      const broken = { ...noopRenderer, [method]: 'not-a-function' };
      expect(() => validateRenderer(broken, 'test-game')).toThrow(
        new RegExp(method)
      );
    });
  }

  test('warns (does not throw) for unrecognised extra methods', () => {
    const withExtra = { ...noopRenderer, doSomethingWeird: () => {} };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => validateRenderer(withExtra, 'test-game')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unrecognised/i));
    warnSpy.mockRestore();
  });

  test('RENDERER_REQUIRED_METHODS contains exactly init, update, destroy', () => {
    expect(RENDERER_REQUIRED_METHODS).toEqual(
      expect.arrayContaining(['init', 'update', 'destroy'])
    );
    expect(RENDERER_REQUIRED_METHODS).toHaveLength(3);
  });

  test('RENDERER_OPTIONAL_METHODS contains onEvent', () => {
    expect(RENDERER_OPTIONAL_METHODS).toContain('onEvent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  No-op stub — validateRenderer passes, update is idempotent
// ─────────────────────────────────────────────────────────────────────────────

describe('no-op stub renderer', () => {
  test('passes validateRenderer', () => {
    expect(() => validateRenderer(noopRenderer, 'noop')).not.toThrow();
  });

  test('update is idempotent: container innerHTML unchanged after two calls', () => {
    const container = makeContainer();
    const state = makeState();
    noopRenderer.init(container, state, 'user-1', () => {});
    noopRenderer.update(state);
    const htmlAfterFirst = container.innerHTML;
    noopRenderer.update(state);
    expect(container.innerHTML).toBe(htmlAfterFirst);
    noopRenderer.destroy();
    container.remove();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tracking stub — init/destroy lifecycle and update idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('tracking stub renderer', () => {
  let _container = null;
  let _myUserId  = null;
  let _emit      = null;

  const INNER_HTML = '<div class="game-board">stub content</div>';

  const trackingRenderer = {
    init(container, state, myUserId, emitAction) {
      _container = container;
      _myUserId  = myUserId;
      _emit      = emitAction;
      container.innerHTML = INNER_HTML;
    },

    update(state) {
      // Idempotent: always set to the same value, never append.
      _container.querySelector('.game-board').textContent = `turn:${state.turn ?? 0}`;
    },

    destroy() {
      if (_container) {
        _container.innerHTML = '';
      }
      _container = null;
      _myUserId  = null;
      _emit      = null;
    },
  };

  test('passes validateRenderer', () => {
    expect(() => validateRenderer(trackingRenderer, 'tracking')).not.toThrow();
  });

  test('init populates the container', () => {
    const container = makeContainer();
    const state = makeState({ turn: 0 });
    const emit  = jest.fn();

    trackingRenderer.init(container, state, 'player-42', emit);
    expect(container.innerHTML).toBe(INNER_HTML);
    expect(_myUserId).toBe('player-42');
    expect(_emit).toBe(emit);
    container.remove();
  });

  test('destroy clears the container and nulls internal refs', () => {
    const container = makeContainer();
    trackingRenderer.init(container, makeState(), 'p1', () => {});
    trackingRenderer.destroy();
    expect(container.innerHTML).toBe('');
    expect(_container).toBeNull();
    expect(_myUserId).toBeNull();
    expect(_emit).toBeNull();
    container.remove();
  });

  test('update is idempotent: same state twice produces identical DOM', () => {
    const container = makeContainer();
    const state = makeState({ turn: 3 });

    trackingRenderer.init(container, state, 'p1', () => {});
    trackingRenderer.update(state);
    const htmlAfterFirst = container.innerHTML;

    trackingRenderer.update(state);
    expect(container.innerHTML).toBe(htmlAfterFirst);

    trackingRenderer.destroy();
    container.remove();
  });

  test('update reflects state changes across two different states', () => {
    const container = makeContainer();

    trackingRenderer.init(container, makeState({ turn: 0 }), 'p1', () => {});
    trackingRenderer.update(makeState({ turn: 1 }));
    const htmlTurn1 = container.innerHTML;

    trackingRenderer.update(makeState({ turn: 2 }));
    const htmlTurn2 = container.innerHTML;

    expect(htmlTurn1).not.toBe(htmlTurn2);

    trackingRenderer.destroy();
    container.remove();
  });
});
