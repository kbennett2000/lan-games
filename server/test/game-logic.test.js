'use strict';

const gl = require('../src/game-logic');
const { makePlayer, makeState } = require('./fixtures');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Return a state where p1 owns a brown monopoly (positions 1 and 3). */
function stateWithBrownMonopoly(extra = {}) {
  const state = makeState(extra);
  state.properties[1].ownerId = 'p1';
  state.properties[3].ownerId = 'p1';
  return state;
}

/** Return a state where p1 is in the post-roll phase. */
function postRoll(base) {
  const state = base || makeState();
  state.turnState.phase = 'post-roll';
  state.turnState.dice  = [3, 4];
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  initGame
// ═══════════════════════════════════════════════════════════════════════════════

describe('initGame', () => {
  const { makeConfig } = require('./fixtures');
  const config   = makeConfig();
  const players  = [
    { userId: 'u1', username: 'Alice', color: 'red',  colorHex: '#f00', token: '🎩' },
    { userId: 'u2', username: 'Bob',   color: 'blue', colorHex: '#00f', token: '🚂' },
  ];

  test('sets status to playing', () => {
    const s = gl.initGame('g1', 'Test', players, config);
    expect(s.status).toBe('playing');
  });

  test('gives every player the configured starting money', () => {
    const s = gl.initGame('g1', 'Test', players, config);
    s.players.forEach(p => expect(p.money).toBe(config.settings.startingMoney));
  });

  test('places all players on Go (position 0)', () => {
    const s = gl.initGame('g1', 'Test', players, config);
    s.players.forEach(p => expect(p.position).toBe(0));
  });

  test('marks all purchasable squares as unowned', () => {
    const s = gl.initGame('g1', 'Test', players, config);
    for (const ps of Object.values(s.properties)) {
      expect(ps.ownerId).toBeNull();
      expect(ps.houses).toBe(0);
      expect(ps.mortgaged).toBe(false);
    }
  });

  test('starts on pre-roll for player 0', () => {
    const s = gl.initGame('g1', 'Test', players, config);
    expect(s.turnState.currentPlayerIndex).toBe(0);
    expect(s.turnState.phase).toBe('pre-roll');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  rollDice
// ═══════════════════════════════════════════════════════════════════════════════

describe('rollDice', () => {
  test('rejects when it is not the caller\'s turn', () => {
    const { error } = gl.rollDice(makeState(), 'p2');
    expect(error).toBeDefined();
  });

  test('rejects when not in pre-roll phase', () => {
    const state = makeState({ turnState: { currentPlayerIndex: 0, phase: 'post-roll', dice: [1,2], doubles: 0, cardDrawn: null } });
    const { error } = gl.rollDice(state, 'p1');
    expect(error).toBeDefined();
  });

  test('moves the current player', () => {
    const { state, error } = gl.rollDice(makeState(), 'p1');
    expect(error).toBeUndefined();
    expect(state.players[0].position).toBeGreaterThan(0);
  });

  test('emits DICE_ROLLED event', () => {
    const { events } = gl.rollDice(makeState(), 'p1');
    expect(events.some(e => e.type === 'DICE_ROLLED')).toBe(true);
  });

  test('player collects go salary when passing Go', () => {
    // Control dice: 5+4=9 from position 36 → newPos=5 (Reading Railroad, unowned, safe)
    // passedGo: 36+9=45 >= 40 ✓, newPos=5 ≠ 0 ✓ → salary credited, no landing cost
    const spy = jest.spyOn(Math, 'random')
      .mockReturnValueOnce(0.7)   // Math.floor(0.7*6)+1 = 5
      .mockReturnValueOnce(0.55); // Math.floor(0.55*6)+1 = 4
    const state = makeState({
      players: [makePlayer('p1', 'Alice', { position: 36 }), makePlayer('p2', 'Bob')],
    });
    const result = gl.rollDice(state, 'p1');
    spy.mockRestore();

    expect(result.events.some(e => e.type === 'PASSED_GO')).toBe(true);
    expect(result.state.players[0].money).toBe(1700); // 1500 + 200 go salary
  });

  test('sends player to jail on three consecutive doubles', () => {
    const state = makeState({
      turnState: { currentPlayerIndex: 0, phase: 'pre-roll', dice: [0,0], doubles: 2, cardDrawn: null },
    });
    // Force doubles by mocking Math.random to always return the same value
    const origRandom = Math.random;
    Math.random = () => 0; // always rolls 1 on each die → doubles
    const { state: s, events } = gl.rollDice(state, 'p1');
    Math.random = origRandom;
    expect(s.players[0].inJail).toBe(true);
    expect(events.some(e => e.type === 'PLAYER_JAILED')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buyProperty
// ═══════════════════════════════════════════════════════════════════════════════

describe('buyProperty', () => {
  function buyingState(moneyOverride) {
    return makeState({
      players: [makePlayer('p1', 'Alice', { position: 1, money: moneyOverride ?? 1500 }), makePlayer('p2', 'Bob')],
      turnState: { currentPlayerIndex: 0, phase: 'buying', dice: [1,0], doubles: 0, cardDrawn: null },
    });
  }

  test('rejects when not in buying phase', () => {
    const { error } = gl.buyProperty(makeState(), 'p1');
    expect(error).toBeDefined();
  });

  test('rejects when not the current player', () => {
    const { error } = gl.buyProperty(buyingState(), 'p2');
    expect(error).toBeDefined();
  });

  test('rejects when player cannot afford it', () => {
    const { error } = gl.buyProperty(buyingState(10), 'p1');
    expect(error).toBeDefined();
  });

  test('assigns ownership and deducts purchase price', () => {
    const { state, error } = gl.buyProperty(buyingState(), 'p1');
    expect(error).toBeUndefined();
    expect(state.properties[1].ownerId).toBe('p1');
    expect(state.players[0].money).toBe(1500 - 60); // Mediterranean costs $60
  });

  test('emits MONOPOLY_ACHIEVED when completing a color group', () => {
    const state = buyingState();
    state.properties[3].ownerId = 'p1'; // already owns Baltic
    const { events } = gl.buyProperty(state, 'p1');
    expect(events.some(e => e.type === 'MONOPOLY_ACHIEVED')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  endTurn
// ═══════════════════════════════════════════════════════════════════════════════

describe('endTurn', () => {
  test('rejects when not in post-roll phase', () => {
    const { error } = gl.endTurn(makeState(), 'p1');
    expect(error).toBeDefined();
  });

  test('rejects when not the current player', () => {
    const { error } = gl.endTurn(postRoll(), 'p2');
    expect(error).toBeDefined();
  });

  test('advances to the next non-bankrupt player', () => {
    const { state } = gl.endTurn(postRoll(), 'p1');
    expect(state.turnState.currentPlayerIndex).toBe(1);
    expect(state.turnState.phase).toBe('pre-roll');
  });

  test('skips bankrupt players', () => {
    const state = postRoll(makeState({
      players: [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob', { isBankrupt: true }), makePlayer('p3', 'Charlie')],
    }));
    const { state: s } = gl.endTurn(state, 'p1');
    expect(s.turnState.currentPlayerIndex).toBe(2); // p2 is bankrupt, skip to p3
  });

  test('declares game over when only one active player remains', () => {
    const state = postRoll(makeState({
      players: [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob', { isBankrupt: true })],
    }));
    const { state: s, events } = gl.endTurn(state, 'p1');
    expect(s.status).toBe('finished');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });

  test('clears any pending trade', () => {
    const state = postRoll();
    state.trade = { fromUserId: 'p1', toUserId: 'p2', status: 'pending' };
    const { state: s } = gl.endTurn(state, 'p1');
    expect(s.trade).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buildHouse / sellHouse
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildHouse', () => {
  test('rejects when not the current player\'s turn', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 500;
    // p2 tries to build on their own property but it's p1's turn
    state.properties[1].ownerId = 'p2';
    state.properties[3].ownerId = 'p2';
    const { error } = gl.buildHouse(state, 'p2', 1);
    expect(error).toMatch(/turn/i);
  });

  test('rejects when phase is not pre-roll or post-roll', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 500;
    state.turnState.phase = 'buying';
    const { error } = gl.buildHouse(state, 'p1', 1);
    expect(error).toBeDefined();
  });

  test('rejects without a monopoly', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1'; // only one of the brown group
    state.players[0].money = 500;
    const { error } = gl.buildHouse(state, 'p1', 1);
    expect(error).toMatch(/monopoly/i);
  });

  test('rejects if player cannot afford it', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 10; // house costs $50
    const { error } = gl.buildHouse(state, 'p1', 1);
    expect(error).toBeDefined();
  });

  test('builds a house and deducts cost', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 500;
    const { state: s, error } = gl.buildHouse(state, 'p1', 1);
    expect(error).toBeUndefined();
    expect(s.properties[1].houses).toBe(1);
    expect(s.players[0].money).toBe(450); // 500 - 50
  });

  test('enforces even-building rule', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 500;
    state.properties[1].houses = 1; // already has one house
    // Cannot build second house on pos 1 when pos 3 still has 0
    const { error } = gl.buildHouse(state, 'p1', 1);
    expect(error).toMatch(/evenly/i);
  });

  test('builds a hotel when upgrading from 4 houses', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 500;
    state.properties[1].houses = 4;
    state.properties[3].houses = 4;
    const { state: s, error } = gl.buildHouse(state, 'p1', 1);
    expect(error).toBeUndefined();
    expect(s.properties[1].houses).toBe(5); // 5 = hotel
  });
});

describe('sellHouse', () => {
  test('rejects when not the current player\'s turn', () => {
    const state = stateWithBrownMonopoly();
    state.properties[1].houses = 1;
    state.properties[3].houses = 1;
    state.properties[1].ownerId = 'p2';
    state.properties[3].ownerId = 'p2';
    const { error } = gl.sellHouse(state, 'p2', 1);
    expect(error).toMatch(/turn/i);
  });

  test('rejects when no buildings exist', () => {
    const state = stateWithBrownMonopoly();
    const { error } = gl.sellHouse(state, 'p1', 1);
    expect(error).toBeDefined();
  });

  test('refunds half the house cost', () => {
    const state = stateWithBrownMonopoly();
    state.players[0].money = 100;
    state.properties[1].houses = 1;
    state.properties[3].houses = 1;
    const { state: s, error } = gl.sellHouse(state, 'p1', 1);
    expect(error).toBeUndefined();
    expect(s.properties[1].houses).toBe(0);
    expect(s.players[0].money).toBe(100 + 25); // sell at half of $50
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  mortgageProperty / unmortgageProperty
// ═══════════════════════════════════════════════════════════════════════════════

describe('mortgageProperty', () => {
  test('rejects when not the current player\'s turn', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p2';
    const { error } = gl.mortgageProperty(state, 'p2', 1);
    expect(error).toMatch(/turn/i);
  });

  test('rejects when player does not own the property', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p2';
    const { error } = gl.mortgageProperty(state, 'p1', 1);
    expect(error).toBeDefined();
  });

  test('rejects when buildings are present', () => {
    const state = stateWithBrownMonopoly();
    state.properties[1].houses = 1;
    const { error } = gl.mortgageProperty(state, 'p1', 1);
    expect(error).toBeDefined();
  });

  test('mortgages the property and pays the player', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1';
    state.players[0].money = 100;
    const { state: s, error } = gl.mortgageProperty(state, 'p1', 1);
    expect(error).toBeUndefined();
    expect(s.properties[1].mortgaged).toBe(true);
    expect(s.players[0].money).toBe(100 + 30); // mortgage value = $30
  });
});

describe('unmortgageProperty', () => {
  test('rejects when not the current player\'s turn', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p2';
    state.properties[1].mortgaged = true;
    const { error } = gl.unmortgageProperty(state, 'p2', 1);
    expect(error).toMatch(/turn/i);
  });

  test('rejects when player cannot afford the unmortgage cost', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1';
    state.properties[1].mortgaged = true;
    state.players[0].money = 5; // unmortgage costs $33
    const { error } = gl.unmortgageProperty(state, 'p1', 1);
    expect(error).toBeDefined();
  });

  test('unmortgages and deducts cost', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1';
    state.properties[1].mortgaged = true;
    state.players[0].money = 200;
    const { state: s, error } = gl.unmortgageProperty(state, 'p1', 1);
    expect(error).toBeUndefined();
    expect(s.properties[1].mortgaged).toBe(false);
    expect(s.players[0].money).toBe(200 - 33);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  payJailFine / useJailCard
// ═══════════════════════════════════════════════════════════════════════════════

describe('payJailFine', () => {
  function jailState() {
    return makeState({
      players: [makePlayer('p1', 'Alice', { inJail: true, jailTurns: 1 }), makePlayer('p2', 'Bob')],
    });
  }

  test('rejects when not in jail', () => {
    const { error } = gl.payJailFine(makeState(), 'p1');
    expect(error).toBeDefined();
  });

  test('rejects when player cannot afford fine', () => {
    const state = jailState();
    state.players[0].money = 10;
    const { error } = gl.payJailFine(state, 'p1');
    expect(error).toBeDefined();
  });

  test('pays the fine and releases from jail', () => {
    const state = jailState();
    const { state: s, error } = gl.payJailFine(state, 'p1');
    expect(error).toBeUndefined();
    expect(s.players[0].inJail).toBe(false);
    expect(s.players[0].money).toBe(1500 - 50);
  });
});

describe('useJailCard', () => {
  test('rejects when player has no jail card', () => {
    const state = makeState({
      players: [makePlayer('p1', 'Alice', { inJail: true, jailCards: 0 }), makePlayer('p2', 'Bob')],
    });
    const { error } = gl.useJailCard(state, 'p1');
    expect(error).toBeDefined();
  });

  test('uses the card and releases from jail', () => {
    const state = makeState({
      players: [makePlayer('p1', 'Alice', { inJail: true, jailCards: 1 }), makePlayer('p2', 'Bob')],
    });
    const { state: s, error } = gl.useJailCard(state, 'p1');
    expect(error).toBeUndefined();
    expect(s.players[0].inJail).toBe(false);
    expect(s.players[0].jailCards).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  offerTrade / acceptTrade / rejectTrade / cancelTrade
// ═══════════════════════════════════════════════════════════════════════════════

describe('offerTrade', () => {
  test('rejects self-trade', () => {
    const { error } = gl.offerTrade(makeState(), 'p1', 'p1', 0, [], 0, 0, [], 0);
    expect(error).toBeDefined();
  });

  test('rejects when offerer lacks the money', () => {
    const state = makeState({ players: [makePlayer('p1', 'Alice', { money: 10 }), makePlayer('p2', 'Bob')] });
    const { error } = gl.offerTrade(state, 'p1', 'p2', 500, [], 0, 0, [], 0);
    expect(error).toBeDefined();
  });

  test('rejects when offerer does not own the offered property', () => {
    const state = makeState();
    // p1 offers pos 1 but doesn't own it
    const { error } = gl.offerTrade(state, 'p1', 'p2', 0, [1], 0, 0, [], 0);
    expect(error).toBeDefined();
  });

  test('creates a pending trade', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1';
    const { state: s, error } = gl.offerTrade(state, 'p1', 'p2', 100, [1], 0, 50, [], 0);
    expect(error).toBeUndefined();
    expect(s.trade).not.toBeNull();
    expect(s.trade.status).toBe('pending');
    expect(s.trade.fromUserId).toBe('p1');
  });
});

describe('acceptTrade', () => {
  function tradeState() {
    const state = makeState({
      players: [makePlayer('p1', 'Alice', { money: 500 }), makePlayer('p2', 'Bob', { money: 500 })],
    });
    state.properties[1].ownerId = 'p1';
    state.trade = {
      fromUserId: 'p1', toUserId: 'p2',
      offerMoney: 100, offerProps: [1], offerCards: 0,
      requestMoney: 50, requestProps: [], requestCards: 0,
      status: 'pending',
    };
    return state;
  }

  test('rejects when trade is not addressed to caller', () => {
    const { error } = gl.acceptTrade(tradeState(), 'p1'); // p1 is the sender, not recipient
    expect(error).toBeDefined();
  });

  test('exchanges money and properties', () => {
    const { state: s, error } = gl.acceptTrade(tradeState(), 'p2');
    expect(error).toBeUndefined();
    expect(s.properties[1].ownerId).toBe('p2'); // property transferred
    expect(s.players[0].money).toBe(500 - 100 + 50);  // p1: paid 100, received 50
    expect(s.players[1].money).toBe(500 + 100 - 50);  // p2: received 100, paid 50
    expect(s.trade).toBeNull();
  });
});

describe('rejectTrade', () => {
  test('clears the trade', () => {
    const state = makeState();
    state.trade = { fromUserId: 'p1', toUserId: 'p2', status: 'pending' };
    const { state: s, error } = gl.rejectTrade(state, 'p2');
    expect(error).toBeUndefined();
    expect(s.trade).toBeNull();
  });
});

describe('cancelTrade', () => {
  test('rejects if caller is not the sender', () => {
    const state = makeState();
    state.trade = { fromUserId: 'p1', toUserId: 'p2', status: 'pending' };
    const { error } = gl.cancelTrade(state, 'p2');
    expect(error).toBeDefined();
  });

  test('clears the trade', () => {
    const state = makeState();
    state.trade = { fromUserId: 'p1', toUserId: 'p2', status: 'pending' };
    const { state: s, error } = gl.cancelTrade(state, 'p1');
    expect(error).toBeUndefined();
    expect(s.trade).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  declareBankruptcy
// ═══════════════════════════════════════════════════════════════════════════════

describe('declareBankruptcy', () => {
  test('marks the player bankrupt', () => {
    const state = makeState();
    const { state: s } = gl.declareBankruptcy(state, 0, null);
    expect(s.players[0].isBankrupt).toBe(true);
  });

  test('transfers properties to the bank when no creditor', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1';
    const { state: s } = gl.declareBankruptcy(state, 0, null);
    expect(s.properties[1].ownerId).toBeNull();
  });

  test('transfers properties to the creditor', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p1';
    const { state: s } = gl.declareBankruptcy(state, 0, 'p2');
    expect(s.properties[1].ownerId).toBe('p2');
  });

  test('zeroes bankrupt player\'s money', () => {
    const state = makeState();
    const { state: s } = gl.declareBankruptcy(state, 0, null);
    expect(s.players[0].money).toBe(0);
  });

  test('triggers GAME_OVER when only one player remains', () => {
    const state = makeState({
      players: [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')],
    });
    const { state: s, events } = gl.declareBankruptcy(state, 0, null);
    expect(s.status).toBe('finished');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  skipTurn
// ═══════════════════════════════════════════════════════════════════════════════

describe('skipTurn', () => {
  test('rejects when it is not this player\'s turn', () => {
    const { error } = gl.skipTurn(makeState(), 'p2');
    expect(error).toBeDefined();
  });

  test('advances to the next player regardless of phase', () => {
    for (const phase of ['pre-roll', 'post-roll', 'buying']) {
      const state = makeState();
      state.turnState.phase = phase;
      const { state: s, error } = gl.skipTurn(state, 'p1');
      expect(error).toBeUndefined();
      expect(s.turnState.currentPlayerIndex).toBe(1);
      expect(s.turnState.phase).toBe('pre-roll');
    }
  });

  test('clears any pending auction and trade', () => {
    const state = makeState();
    state.auction = { position: 1, bids: {}, passed: [], highBidder: null, highBid: 0 };
    state.trade   = { fromUserId: 'p1', toUserId: 'p2', status: 'pending' };
    const { state: s } = gl.skipTurn(state, 'p1');
    expect(s.auction).toBeNull();
    expect(s.trade).toBeNull();
  });

  test('emits TURN_SKIPPED event', () => {
    const { events } = gl.skipTurn(makeState(), 'p1');
    expect(events.some(e => e.type === 'TURN_SKIPPED')).toBe(true);
  });

  test('detects game over when only one active player remains', () => {
    const state = makeState({
      players: [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob', { isBankrupt: true })],
    });
    const { state: s, events } = gl.skipTurn(state, 'p1');
    expect(s.status).toBe('finished');
    expect(events.some(e => e.type === 'GAME_OVER')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  calculateRent
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculateRent', () => {
  test('returns 0 for unowned property', () => {
    const state = makeState();
    expect(gl.calculateRent(state, 1, [3, 4])).toBe(0);
  });

  test('returns 0 for mortgaged property', () => {
    const state = makeState();
    state.properties[1].ownerId  = 'p2';
    state.properties[1].mortgaged = true;
    expect(gl.calculateRent(state, 1, [3, 4])).toBe(0);
  });

  test('returns base rent for unimproved property (no monopoly)', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p2'; // owns only one of the brown group
    expect(gl.calculateRent(state, 1, [3, 4])).toBe(2); // base rent
  });

  test('returns monopoly rent when owner has the full color group', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p2';
    state.properties[3].ownerId = 'p2';
    expect(gl.calculateRent(state, 1, [3, 4])).toBe(4); // monopoly rent
  });

  test('returns house-based rent when buildings are present', () => {
    const state = makeState();
    state.properties[1].ownerId = 'p2';
    state.properties[3].ownerId = 'p2';
    state.properties[1].houses  = 2;
    expect(gl.calculateRent(state, 1, [3, 4])).toBe(30); // twoHouses rent
  });

  test('returns railroad rent scaled by number owned', () => {
    const state = makeState();
    state.properties[5].ownerId  = 'p2';
    state.properties[15].ownerId = 'p2';
    expect(gl.calculateRent(state, 5, [3, 4])).toBe(50); // 2 railroads = $50
  });

  test('returns utility rent as dice × multiplier', () => {
    const state = makeState();
    state.properties[12].ownerId = 'p2';
    // One utility owned: multiplier1 = 4
    expect(gl.calculateRent(state, 12, [3, 4])).toBe((3 + 4) * 4); // 28
  });
});
