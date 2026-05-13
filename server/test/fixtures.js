'use strict';

/**
 * Minimal but complete game fixtures for unit tests.
 * Provides makeConfig(), makePlayer(), and makeState().
 */

function makeBoard() {
  // Start with 40 inert squares, then override the ones tests actually use.
  const board = Array.from({ length: 40 }, (_, i) => ({
    position: i, type: 'go', name: `Square ${i}`,
  }));

  board[0]  = { position: 0,  type: 'go',            name: 'Go' };
  board[1]  = { position: 1,  type: 'property',       name: 'Mediterranean Ave', colorGroup: 'brown',
                price: 60, houseCost: 50, hotelCost: 50, mortgage: 30, unmortgageCost: 33,
                rent: { base: 2, monopoly: 4, oneHouse: 10, twoHouses: 30, threeHouses: 90, fourHouses: 160, hotel: 250 } };
  board[2]  = { position: 2,  type: 'community_chest', name: 'Community Chest' };
  board[3]  = { position: 3,  type: 'property',       name: 'Baltic Ave', colorGroup: 'brown',
                price: 60, houseCost: 50, hotelCost: 50, mortgage: 30, unmortgageCost: 33,
                rent: { base: 4, monopoly: 8, oneHouse: 20, twoHouses: 60, threeHouses: 180, fourHouses: 320, hotel: 450 } };
  board[4]  = { position: 4,  type: 'tax',            name: 'Income Tax',    taxType: 'income',  amount: 200, percentOption: 10 };
  board[5]  = { position: 5,  type: 'railroad',       name: 'Reading Railroad',
                price: 200, mortgage: 100, unmortgageCost: 110,
                rent: { owned1: 25, owned2: 50, owned3: 100, owned4: 200 } };
  board[7]  = { position: 7,  type: 'chance',         name: 'Chance' };
  board[10] = { position: 10, type: 'jail',            name: 'Jail / Just Visiting' };
  board[12] = { position: 12, type: 'utility',        name: 'Electric Company',
                price: 150, mortgage: 75, unmortgageCost: 83,
                rent: { multiplier1: 4, multiplier2: 10 } };
  board[15] = { position: 15, type: 'railroad',       name: 'Pennsylvania Railroad',
                price: 200, mortgage: 100, unmortgageCost: 110,
                rent: { owned1: 25, owned2: 50, owned3: 100, owned4: 200 } };
  board[20] = { position: 20, type: 'free_parking',   name: 'Free Parking' };
  board[25] = { position: 25, type: 'railroad',       name: 'B&O Railroad',
                price: 200, mortgage: 100, unmortgageCost: 110,
                rent: { owned1: 25, owned2: 50, owned3: 100, owned4: 200 } };
  board[28] = { position: 28, type: 'utility',        name: 'Water Works',
                price: 150, mortgage: 75, unmortgageCost: 83,
                rent: { multiplier1: 4, multiplier2: 10 } };
  board[30] = { position: 30, type: 'go_to_jail',     name: 'Go To Jail' };
  board[35] = { position: 35, type: 'railroad',       name: 'Short Line Railroad',
                price: 200, mortgage: 100, unmortgageCost: 110,
                rent: { owned1: 25, owned2: 50, owned3: 100, owned4: 200 } };
  board[38] = { position: 38, type: 'tax',            name: 'Luxury Tax',    taxType: 'luxury',  amount: 75 };

  return board;
}

function makeConfig(overrides = {}) {
  return {
    board: makeBoard(),
    cards: {
      chance: [
        { id: 'ch-advance-go',  text: 'Advance to Go',       action: 'advance_to',      data: { position: 0,  collectGoSalary: false } },
        { id: 'ch-jail',        text: 'Go to Jail',          action: 'go_to_jail',      data: {} },
        { id: 'ch-collect-50',  text: 'Bank pays you $50',   action: 'collect',          data: { amount: 50 } },
        { id: 'ch-jail-card',   text: 'Get Out of Jail Free', action: 'get_out_of_jail', data: {} },
      ],
      communityChest: [
        { id: 'cc-collect-200', text: 'Bank error – collect $200', action: 'collect', data: { amount: 200 } },
        { id: 'cc-pay-50',      text: 'Doctor\'s fee – pay $50',   action: 'pay',     data: { amount: 50  } },
      ],
    },
    settings: {
      startingMoney:    1500,
      goSalary:          200,
      jailFine:           50,
      jailMaxTurns:        3,
      jailPosition:       10,
      maxHousesInBank:    32,
      maxHotelsInBank:    12,
      auctionEnabled:   true,
      auctionMinBid:       1,
      freeParkingJackpot: false,
      incomeTaxChoice:  false,
      minPlayersToStart:   2,
      maxPlayers:          8,
      tradeEnabled:     true,
      playerColors:       [],
      playerTokens:       [],
    },
    colorGroups:       { brown: [1, 3] },
    railroadPositions: [5, 15, 25, 35],
    utilityPositions:  [12, 28],
    ...overrides,
  };
}

function makePlayer(id, username, overrides = {}) {
  return {
    userId:    id,
    username,
    color:     'red',
    colorHex:  '#DC143C',
    token:     '🎩',
    position:  0,
    money:     1500,
    inJail:    false,
    jailTurns: 0,
    jailCards: 0,
    isBankrupt: false,
    connected: true,
    ...overrides,
  };
}

/** Build a ready-to-use playing-state. players defaults to [Alice p1, Bob p2]. */
function makeState(overrides = {}) {
  const config  = makeConfig();
  const players = overrides.players || [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')];
  delete overrides.players; // handled above

  const properties = {};
  for (const sq of config.board) {
    if (['property', 'railroad', 'utility'].includes(sq.type)) {
      properties[sq.position] = { ownerId: null, houses: 0, mortgaged: false };
    }
  }

  return {
    id:        'test-game',
    name:      'Test Game',
    status:    'playing',
    createdBy: 'p1',
    config,
    players,
    properties,
    turnState: {
      currentPlayerIndex: 0,
      phase:   'pre-roll',
      dice:    [0, 0],
      doubles: 0,
      cardDrawn: null,
    },
    auction:     null,
    trade:       null,
    chanceDeck:  [0, 1, 2, 3],
    chestDeck:   [0, 1],
    freeParking: 0,
    log:         [],
    ...overrides,
  };
}

module.exports = { makeConfig, makePlayer, makeState };
