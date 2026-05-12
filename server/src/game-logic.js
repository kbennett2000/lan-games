/**
 * game-logic.js
 *
 * Pure Monopoly game engine.  All functions are side-effect free: they accept
 * a game state object, return a NEW state object and an array of event objects
 * that describe what happened.  The caller (game-manager / socket-handler) is
 * responsible for persisting the state and broadcasting events.
 *
 * ─── State shape ─────────────────────────────────────────────────────────────
 *
 * GameState {
 *   id        : string            game UUID
 *   name      : string
 *   status    : 'waiting' | 'playing' | 'paused' | 'finished'
 *   config    : GameConfig        embedded copy of config-loader output
 *   players   : Player[]
 *   properties: { [position]: PropertyState }
 *   turnState : TurnState
 *   auction   : Auction | null
 *   trade     : Trade | null
 *   chanceDeck: number[]          indices into config.cards.chance (shuffled)
 *   chestDeck : number[]          indices into config.cards.communityChest
 *   freeParking: number           money in the free parking pot (if rule enabled)
 *   log       : LogEntry[]
 * }
 *
 * Player {
 *   userId    : string
 *   username  : string
 *   color     : string
 *   token     : string  (emoji token)
 *   position  : number  (0-39)
 *   money     : number
 *   inJail    : boolean
 *   jailTurns : number  (turns spent in jail so far)
 *   jailCards : number  (Get Out of Jail Free cards held)
 *   isBankrupt: boolean
 *   connected : boolean
 * }
 *
 * PropertyState {
 *   ownerId  : string | null
 *   houses   : number   (0-4 = houses, 5 = hotel)
 *   mortgaged: boolean
 * }
 *
 * TurnState {
 *   currentPlayerIndex: number
 *   phase  : 'pre-roll' | 'post-roll' | 'buying' | 'auctioning' | 'card'
 *   dice   : [number, number]
 *   doubles: number   (consecutive doubles rolled this turn)
 *   cardDrawn: object | null   (current card being resolved)
 * }
 *
 * Auction {
 *   position     : number
 *   bids         : { [userId]: number }
 *   passed       : string[]    (userIds who passed)
 *   highBidder   : string | null
 *   highBid      : number
 * }
 *
 * Trade {
 *   fromUserId   : string
 *   toUserId     : string
 *   offerMoney   : number
 *   offerProps   : number[]   (positions)
 *   offerCards   : number     (jail free cards)
 *   requestMoney : number
 *   requestProps : number[]
 *   requestCards : number
 *   status       : 'pending' | 'accepted' | 'rejected' | 'cancelled'
 * }
 */

'use strict';

// ── helpers ──────────────────────────────────────────────────────────────────

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Roll a single six-sided die. */
function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

/** Fisher-Yates shuffle (mutates the array, returns it). */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Build a shuffled deck of indices 0..n-1 for a card array of length n. */
function buildDeck(n) {
  return shuffle(Array.from({ length: n }, (_, i) => i));
}

/** Add a log entry to state (mutates the cloned state). */
function log(state, message, type = 'info') {
  state.log.push({ timestamp: Date.now(), message, type });
  // Keep the log from growing unbounded
  if (state.log.length > 200) state.log.shift();
}

/** Create a game event object for broadcasting. */
function event(type, data = {}) {
  return { type, data, timestamp: Date.now() };
}

/** Move a position forward by `steps` squares (wrapping at 40). */
function advancePosition(from, steps) {
  return (from + steps) % 40;
}

/** Returns true if the player passed or landed on Go (position 0) while moving `steps`. */
function passedGo(from, steps) {
  return from + steps >= 40;
}

/** Count how many railroads / utilities a player owns. */
function countTypeOwned(state, userId, type) {
  const positions = type === 'railroad'
    ? state.config.railroadPositions
    : state.config.utilityPositions;
  return positions.filter(pos => state.properties[pos]?.ownerId === userId).length;
}

/** Returns true if the player owns all squares in a color group. */
function hasMonopoly(state, userId, colorGroup) {
  const positions = state.config.colorGroups[colorGroup];
  return positions.every(pos => state.properties[pos]?.ownerId === userId);
}

/** Total number of houses/hotels a player has on all their properties. */
function countBuildings(state, userId) {
  let houses = 0;
  let hotels = 0;
  for (const [pos, propState] of Object.entries(state.properties)) {
    if (propState.ownerId !== userId) continue;
    if (propState.houses === 5) hotels++;
    else houses += propState.houses;
  }
  return { houses, hotels };
}

/** Total house and hotel count across ALL properties (for bank limits). */
function totalBuildingsInPlay(state) {
  let houses = 0;
  let hotels = 0;
  for (const propState of Object.values(state.properties)) {
    if (propState.houses === 5) hotels++;
    else houses += propState.houses;
  }
  return { houses, hotels };
}

/** Net worth of a player: cash + property values (at mortgage value). */
function playerNetWorth(state, userId) {
  let worth = 0;
  const player = state.players.find(p => p.userId === userId);
  if (!player) return 0;
  worth += player.money;
  for (const [pos, propState] of Object.entries(state.properties)) {
    if (propState.ownerId !== userId) continue;
    const sq = state.config.board[Number(pos)];
    worth += propState.mortgaged ? 0 : sq.mortgage;
    if (propState.houses > 0 && propState.houses < 5) {
      worth += propState.houses * (sq.houseCost / 2); // sell houses at half price
    }
    if (propState.houses === 5) {
      worth += sq.hotelCost / 2;
    }
  }
  return worth;
}

/** Return the nearest board position of the given type, moving clockwise. */
function nearestOfType(currentPos, positions) {
  // positions is sorted ascending; find the next one clockwise
  for (const pos of positions) {
    if (pos > currentPos) return pos;
  }
  return positions[0]; // wrap around
}

// ── rent calculation ─────────────────────────────────────────────────────────

/**
 * Calculate the rent owed when a player lands on a purchasable square.
 *
 * @param {GameState} state
 * @param {number}    position  board position landed on
 * @param {number[]}  dice      the actual dice values [d1, d2] (needed for utility rent)
 * @param {number}    [rentMultiplierOverride]  for card-driven railroad/utility landings
 */
function calculateRent(state, position, dice, rentMultiplierOverride = 1) {
  const sq        = state.config.board[position];
  const propState = state.properties[position];

  if (!propState || !propState.ownerId || propState.mortgaged) return 0;

  const ownerId = propState.ownerId;

  if (sq.type === 'railroad') {
    const count = countTypeOwned(state, ownerId, 'railroad');
    const baseRent = sq.rent[`owned${count}`];
    return baseRent * rentMultiplierOverride;
  }

  if (sq.type === 'utility') {
    const count  = countTypeOwned(state, ownerId, 'utility');
    const mult   = count === 2 ? sq.rent.multiplier2 : sq.rent.multiplier1;
    const diceSum = dice[0] + dice[1];
    return diceSum * mult * rentMultiplierOverride;
  }

  if (sq.type === 'property') {
    const h = propState.houses;
    if (h === 0) {
      // Unimproved: double rent if owner has the monopoly
      return hasMonopoly(state, ownerId, sq.colorGroup)
        ? sq.rent.monopoly
        : sq.rent.base;
    }
    if (h === 1) return sq.rent.oneHouse;
    if (h === 2) return sq.rent.twoHouses;
    if (h === 3) return sq.rent.threeHouses;
    if (h === 4) return sq.rent.fourHouses;
    if (h === 5) return sq.rent.hotel;
  }

  return 0;
}

// ── card resolution ──────────────────────────────────────────────────────────

/**
 * Apply the effect of a drawn card.  May recurse into processLanding.
 * Returns { state, events }.
 */
function resolveCard(state, playerIdx, card) {
  const events = [];
  state = clone(state);
  const player = state.players[playerIdx];

  log(state, `${player.username} drew: "${card.text}"`, 'card');
  events.push(event('CARD_DRAWN', { username: player.username, card }));

  switch (card.action) {
    case 'advance_to': {
      const dest = card.data.position;
      if (card.data.collectGoSalary && passedGo(player.position, (dest - player.position + 40) % 40)) {
        player.money += state.config.settings.goSalary;
        log(state, `${player.username} passed Go and collected $${state.config.settings.goSalary}`, 'money');
        events.push(event('PASSED_GO', { username: player.username, amount: state.config.settings.goSalary }));
      }
      player.position = dest;
      const landed = processLanding(state, playerIdx, events);
      state  = landed.state;
      events.push(...landed.newEvents);
      break;
    }

    case 'advance_to_nearest': {
      const positions = card.data.type === 'railroad'
        ? state.config.railroadPositions
        : state.config.utilityPositions;
      const dest = nearestOfType(player.position, positions);
      if (card.data.collectGoSalary && passedGo(player.position, (dest - player.position + 40) % 40)) {
        player.money += state.config.settings.goSalary;
        log(state, `${player.username} passed Go and collected $${state.config.settings.goSalary}`, 'money');
        events.push(event('PASSED_GO', { username: player.username, amount: state.config.settings.goSalary }));
      }
      player.position = dest;
      const multiplier = card.data.rentMultiplier || 1;
      const landed = processLanding(state, playerIdx, events, multiplier);
      state  = landed.state;
      events.push(...landed.newEvents);
      break;
    }

    case 'collect': {
      player.money += card.data.amount;
      log(state, `${player.username} collected $${card.data.amount}`, 'money');
      events.push(event('MONEY_RECEIVED', { username: player.username, amount: card.data.amount, source: 'bank' }));
      state.turnState.phase = 'post-roll';
      break;
    }

    case 'pay': {
      const result = chargePlayer(state, playerIdx, card.data.amount, null);
      state  = result.state;
      events.push(...result.events);
      break;
    }

    case 'pay_each_player': {
      for (let i = 0; i < state.players.length; i++) {
        if (i === playerIdx || state.players[i].isBankrupt) continue;
        const result = chargePlayer(state, playerIdx, card.data.amount, state.players[i].userId);
        state  = result.state;
        events.push(...result.events);
      }
      state.turnState.phase = 'post-roll';
      break;
    }

    case 'collect_from_each_player': {
      for (let i = 0; i < state.players.length; i++) {
        if (i === playerIdx || state.players[i].isBankrupt) continue;
        const payer = state.players[i];
        const amount = Math.min(card.data.amount, payer.money);
        payer.money  -= amount;
        player.money += amount;
        log(state, `${payer.username} paid ${player.username} $${amount}`, 'money');
        events.push(event('RENT_PAID', { from: payer.username, to: player.username, amount }));
      }
      state.turnState.phase = 'post-roll';
      break;
    }

    case 'go_to_jail': {
      player.position = state.config.settings.jailPosition;
      player.inJail   = true;
      player.jailTurns = 0;
      log(state, `${player.username} was sent to Jail!`, 'jail');
      events.push(event('PLAYER_JAILED', { username: player.username }));
      state.turnState.phase = 'post-roll';
      state.turnState.doubles = 0; // jail cancels double-roll bonus
      break;
    }

    case 'get_out_of_jail': {
      player.jailCards++;
      log(state, `${player.username} received a Get Out of Jail Free card`, 'card');
      events.push(event('JAIL_CARD_RECEIVED', { username: player.username }));
      state.turnState.phase = 'post-roll';
      break;
    }

    case 'go_back': {
      player.position = (player.position - card.data.spaces + 40) % 40;
      log(state, `${player.username} moved back ${card.data.spaces} spaces to ${state.config.board[player.position].name}`, 'move');
      const landed = processLanding(state, playerIdx, events);
      state  = landed.state;
      events.push(...landed.newEvents);
      break;
    }

    case 'repairs': {
      const { houses, hotels } = countBuildings(state, player.userId);
      const total = houses * card.data.houseCost + hotels * card.data.hotelCost;
      if (total > 0) {
        const result = chargePlayer(state, playerIdx, total, null);
        state  = result.state;
        events.push(...result.events);
        log(state, `${player.username} paid $${total} for property repairs (${houses} houses, ${hotels} hotels)`, 'money');
      } else {
        log(state, `${player.username} has no buildings — no repair cost`, 'info');
        state.turnState.phase = 'post-roll';
      }
      break;
    }
  }

  return { state, events };
}

// ── processLanding ────────────────────────────────────────────────────────────

/**
 * Handle the effects of landing on a board square.
 * Called after movement is complete.
 *
 * @param {GameState} state         (already cloned by caller)
 * @param {number}    playerIdx
 * @param {object[]}  existingEvents  events array to append to
 * @param {number}    [rentMultiplier=1]  for card-driven double-rent landings
 * @returns {{ state, newEvents }}
 */
function processLanding(state, playerIdx, existingEvents = [], rentMultiplier = 1) {
  const newEvents = [];
  const player    = state.players[playerIdx];
  const position  = player.position;
  const sq        = state.config.board[position];
  const propState = state.properties[position];

  log(state, `${player.username} landed on ${sq.name}`, 'move');
  newEvents.push(event('PLAYER_LANDED', { username: player.username, position, squareName: sq.name }));

  switch (sq.type) {
    case 'go':
    case 'jail':
    case 'free_parking': {
      if (sq.type === 'free_parking' && state.config.settings.freeParkingJackpot && state.freeParking > 0) {
        const pot = state.freeParking;
        player.money += pot;
        state.freeParking = 0;
        log(state, `${player.username} collected the Free Parking jackpot of $${pot}!`, 'money');
        newEvents.push(event('FREE_PARKING_COLLECTED', { username: player.username, amount: pot }));
      }
      state.turnState.phase = 'post-roll';
      break;
    }

    case 'go_to_jail': {
      player.position  = state.config.settings.jailPosition;
      player.inJail    = true;
      player.jailTurns = 0;
      state.turnState.phase   = 'post-roll';
      state.turnState.doubles = 0;
      log(state, `${player.username} went to Jail!`, 'jail');
      newEvents.push(event('PLAYER_JAILED', { username: player.username }));
      break;
    }

    case 'tax': {
      let amount = sq.amount;
      // Income Tax: player may choose lesser of flat amount or percent of net worth
      if (sq.taxType === 'income' && state.config.settings.incomeTaxChoice) {
        const percentAmount = Math.floor(playerNetWorth(state, player.userId) * sq.percentOption / 100);
        amount = Math.min(sq.amount, percentAmount);
      }
      const result = chargePlayer(state, playerIdx, amount, null);
      state = result.state;
      newEvents.push(...result.events);
      log(state, `${player.username} paid $${amount} in ${sq.name}`, 'money');
      break;
    }

    case 'chance': {
      // Draw top card; reshuffle if deck is empty
      if (state.chanceDeck.length === 0) {
        state.chanceDeck = buildDeck(state.config.cards.chance.length);
      }
      const cardIdx = state.chanceDeck.pop();
      const card    = state.config.cards.chance[cardIdx];
      state.turnState.phase = 'card';
      const resolved = resolveCard(state, playerIdx, card);
      state = resolved.state;
      newEvents.push(...resolved.events);
      break;
    }

    case 'community_chest': {
      if (state.chestDeck.length === 0) {
        state.chestDeck = buildDeck(state.config.cards.communityChest.length);
      }
      const cardIdx = state.chestDeck.pop();
      const card    = state.config.cards.communityChest[cardIdx];
      state.turnState.phase = 'card';
      const resolved = resolveCard(state, playerIdx, card);
      state = resolved.state;
      newEvents.push(...resolved.events);
      break;
    }

    case 'property':
    case 'railroad':
    case 'utility': {
      if (!propState.ownerId) {
        // Unowned — offer purchase decision
        state.turnState.phase = 'buying';
        log(state, `${player.username} can buy ${sq.name} for $${sq.price}`, 'info');
        newEvents.push(event('PROPERTY_FOR_SALE', { username: player.username, position, name: sq.name, price: sq.price }));
      } else if (propState.ownerId === player.userId) {
        // Owned by self — nothing happens
        state.turnState.phase = 'post-roll';
        log(state, `${player.username} owns ${sq.name} — no rent`, 'info');
      } else if (propState.mortgaged) {
        // Mortgaged — no rent
        state.turnState.phase = 'post-roll';
        log(state, `${sq.name} is mortgaged — no rent due`, 'info');
      } else {
        // Owned by someone else — pay rent
        const rent = calculateRent(state, position, state.turnState.dice, rentMultiplier);
        const owner = state.players.find(p => p.userId === propState.ownerId);
        const result = chargePlayer(state, playerIdx, rent, propState.ownerId);
        state = result.state;
        newEvents.push(...result.events);
        if (owner) {
          log(state, `${player.username} paid $${rent} rent to ${owner.username} for ${sq.name}`, 'money');
          newEvents.push(event('RENT_PAID', { from: player.username, to: owner.username, amount: rent, property: sq.name }));
        }
      }
      break;
    }

    default:
      state.turnState.phase = 'post-roll';
  }

  return { state, newEvents };
}

// ── chargePlayer ─────────────────────────────────────────────────────────────

/**
 * Charge a player money, paying it to another player or the bank.
 * If the player can't afford it, they go bankrupt.
 * Returns { state, events }.
 */
function chargePlayer(state, playerIdx, amount, recipientUserId) {
  const events = [];
  state = clone(state);
  const player = state.players[playerIdx];

  if (player.money >= amount) {
    player.money -= amount;
    if (recipientUserId) {
      const recipient = state.players.find(p => p.userId === recipientUserId);
      if (recipient) recipient.money += amount;
    } else if (state.config.settings.freeParkingJackpot) {
      // Taxes and fines go to the Free Parking pot
      state.freeParking += amount;
    }
    state.turnState.phase = 'post-roll';
  } else {
    // Player can't afford to pay — they are bankrupt
    const result = declareBankruptcy(state, playerIdx, recipientUserId);
    state  = result.state;
    events.push(...result.events);
  }

  return { state, events };
}

// ── public game actions ───────────────────────────────────────────────────────

/**
 * Initialize a brand new game state.
 *
 * @param {string}     gameId
 * @param {string}     gameName
 * @param {object[]}   playerList  [{ userId, username, color, token }]
 * @param {GameConfig} config      from config-loader.getConfigCopy()
 * @returns {GameState}
 */
function initGame(gameId, gameName, playerList, config) {
  const properties = {};
  for (const sq of config.board) {
    if (['property', 'railroad', 'utility'].includes(sq.type)) {
      properties[sq.position] = { ownerId: null, houses: 0, mortgaged: false };
    }
  }

  const players = playerList.map(p => ({
    userId:    p.userId,
    username:  p.username,
    color:     p.color,
    token:     p.token,
    position:  0,
    money:     config.settings.startingMoney,
    inJail:    false,
    jailTurns: 0,
    jailCards: 0,
    isBankrupt: false,
    connected: true,
  }));

  return {
    id:     gameId,
    name:   gameName,
    status: 'playing',
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
    chanceDeck:  buildDeck(config.cards.chance.length),
    chestDeck:   buildDeck(config.cards.communityChest.length),
    freeParking: 0,
    log: [{ timestamp: Date.now(), message: 'Game started!', type: 'info' }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roll dice and move the current player.
 *
 * @returns {{ state, events, error? }}
 */
function rollDice(state, userId) {
  const events = [];

  const playerIdx = state.turnState.currentPlayerIndex;
  const player    = state.players[playerIdx];

  if (player.userId !== userId) {
    return { state, events, error: 'It is not your turn' };
  }
  if (state.turnState.phase !== 'pre-roll') {
    return { state, events, error: 'You cannot roll right now' };
  }

  state = clone(state);

  const d1 = rollDie();
  const d2 = rollDie();
  const isDoubles = d1 === d2;

  state.turnState.dice = [d1, d2];
  log(state, `${player.username} rolled ${d1} + ${d2} = ${d1 + d2}${isDoubles ? ' (doubles!)' : ''}`, 'dice');
  events.push(event('DICE_ROLLED', { username: player.username, dice: [d1, d2], isDoubles }));

  const currentPlayer = state.players[playerIdx]; // re-reference after clone

  if (currentPlayer.inJail) {
    return handleJailRoll(state, playerIdx, d1, d2, isDoubles, events);
  }

  if (isDoubles) {
    state.turnState.doubles++;
    if (state.turnState.doubles >= 3) {
      // Three consecutive doubles → go to jail
      currentPlayer.position  = state.config.settings.jailPosition;
      currentPlayer.inJail    = true;
      currentPlayer.jailTurns = 0;
      state.turnState.phase   = 'post-roll';
      state.turnState.doubles = 0;
      log(state, `${currentPlayer.username} rolled doubles 3 times and was sent to Jail!`, 'jail');
      events.push(event('PLAYER_JAILED', { username: currentPlayer.username, reason: 'three-doubles' }));
      return { state, events };
    }
  }

  // Normal movement
  const steps   = d1 + d2;
  const oldPos  = currentPlayer.position;
  const newPos  = advancePosition(oldPos, steps);

  if (passedGo(oldPos, steps) && newPos !== 0) {
    currentPlayer.money += state.config.settings.goSalary;
    log(state, `${currentPlayer.username} passed Go and collected $${state.config.settings.goSalary}`, 'money');
    events.push(event('PASSED_GO', { username: currentPlayer.username, amount: state.config.settings.goSalary }));
  }

  currentPlayer.position = newPos;
  log(state, `${currentPlayer.username} moved to ${state.config.board[newPos].name}`, 'move');
  events.push(event('PLAYER_MOVED', { username: currentPlayer.username, from: oldPos, to: newPos, dice: [d1, d2] }));

  const landed = processLanding(state, playerIdx, events);
  state  = landed.state;
  events.push(...landed.newEvents);

  // If doubles and not jailed and not in buying/auctioning phase, allow re-roll
  if (isDoubles && !state.players[playerIdx].inJail && state.turnState.phase === 'post-roll') {
    state.turnState.phase = 'pre-roll';
    log(state, `${currentPlayer.username} rolled doubles — rolls again!`, 'dice');
    events.push(event('DOUBLES_ROLL_AGAIN', { username: currentPlayer.username }));
  }

  return { state, events };
}

function handleJailRoll(state, playerIdx, d1, d2, isDoubles, events) {
  const player = state.players[playerIdx];

  if (isDoubles) {
    // Doubles = get out of jail free (no fine, no card used)
    player.inJail    = false;
    player.jailTurns = 0;
    log(state, `${player.username} rolled doubles and got out of Jail!`, 'jail');
    events.push(event('PLAYER_FREED_FROM_JAIL', { username: player.username, reason: 'doubles' }));

    const steps  = d1 + d2;
    const newPos = advancePosition(player.position, steps);
    if (passedGo(player.position, steps) && newPos !== 0) {
      player.money += state.config.settings.goSalary;
      events.push(event('PASSED_GO', { username: player.username, amount: state.config.settings.goSalary }));
    }
    player.position = newPos;
    events.push(event('PLAYER_MOVED', { username: player.username, from: state.config.settings.jailPosition, to: newPos, dice: [d1, d2] }));

    const landed = processLanding(state, playerIdx, events);
    state  = landed.state;
    events.push(...landed.newEvents);
    // After getting out of jail with doubles, the player does NOT roll again
    if (state.turnState.phase === 'post-roll') state.turnState.phase = 'post-roll';
  } else {
    player.jailTurns++;
    if (player.jailTurns >= state.config.settings.jailMaxTurns) {
      // Forced to pay fine after max turns
      player.money    -= state.config.settings.jailFine;
      player.inJail    = false;
      player.jailTurns = 0;
      log(state, `${player.username} served max jail time and paid $${state.config.settings.jailFine} fine`, 'jail');
      events.push(event('JAIL_FINE_PAID', { username: player.username, amount: state.config.settings.jailFine, forced: true }));

      const steps  = d1 + d2;
      const newPos = advancePosition(player.position, steps);
      player.position = newPos;
      events.push(event('PLAYER_MOVED', { username: player.username, from: state.config.settings.jailPosition, to: newPos, dice: [d1, d2] }));

      const landed = processLanding(state, playerIdx, events);
      state  = landed.state;
      events.push(...landed.newEvents);
    } else {
      // Stay in jail
      state.turnState.phase = 'post-roll';
      log(state, `${player.username} did not roll doubles and stays in Jail (turn ${player.jailTurns}/${state.config.settings.jailMaxTurns})`, 'jail');
      events.push(event('STAYED_IN_JAIL', { username: player.username, jailTurns: player.jailTurns }));
    }
  }

  return { state, events };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pay the jail fine ($50) to exit jail before rolling.
 */
function payJailFine(state, userId) {
  const events    = [];
  const playerIdx = state.turnState.currentPlayerIndex;
  const player    = state.players[playerIdx];

  if (player.userId !== userId) return { state, events, error: 'Not your turn' };
  if (!player.inJail)           return { state, events, error: 'You are not in jail' };
  if (state.turnState.phase !== 'pre-roll') return { state, events, error: 'Cannot pay fine now' };

  if (player.money < state.config.settings.jailFine) {
    return { state, events, error: `Not enough money. Need $${state.config.settings.jailFine}` };
  }

  state = clone(state);
  state.players[playerIdx].money     -= state.config.settings.jailFine;
  state.players[playerIdx].inJail     = false;
  state.players[playerIdx].jailTurns  = 0;

  log(state, `${player.username} paid $${state.config.settings.jailFine} to get out of Jail`, 'jail');
  events.push(event('JAIL_FINE_PAID', { username: player.username, amount: state.config.settings.jailFine }));

  return { state, events };
}

/**
 * Use a Get Out of Jail Free card.
 */
function useJailCard(state, userId) {
  const events    = [];
  const playerIdx = state.turnState.currentPlayerIndex;
  const player    = state.players[playerIdx];

  if (player.userId !== userId) return { state, events, error: 'Not your turn' };
  if (!player.inJail)           return { state, events, error: 'You are not in jail' };
  if (player.jailCards < 1)     return { state, events, error: 'You do not have a Get Out of Jail Free card' };
  if (state.turnState.phase !== 'pre-roll') return { state, events, error: 'Cannot use card now' };

  state = clone(state);
  state.players[playerIdx].jailCards--;
  state.players[playerIdx].inJail    = false;
  state.players[playerIdx].jailTurns = 0;

  log(state, `${player.username} used a Get Out of Jail Free card`, 'jail');
  events.push(event('JAIL_CARD_USED', { username: player.username }));

  return { state, events };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current player buys the property they are standing on.
 */
function buyProperty(state, userId) {
  const events    = [];
  const playerIdx = state.turnState.currentPlayerIndex;
  const player    = state.players[playerIdx];

  if (player.userId !== userId) return { state, events, error: 'Not your turn' };
  if (state.turnState.phase !== 'buying') return { state, events, error: 'Not in buying phase' };

  const position  = player.position;
  const sq        = state.config.board[position];
  const propState = state.properties[position];

  if (!propState || propState.ownerId) return { state, events, error: 'Property not available' };
  if (player.money < sq.price)         return { state, events, error: `Not enough money. Need $${sq.price}` };

  state = clone(state);
  state.players[playerIdx].money -= sq.price;
  state.properties[position].ownerId = player.userId;
  state.turnState.phase = 'post-roll';

  log(state, `${player.username} bought ${sq.name} for $${sq.price}`, 'property');
  events.push(event('PROPERTY_BOUGHT', { username: player.username, position, name: sq.name, price: sq.price }));

  // Check if they now have a monopoly
  if (sq.type === 'property' && hasMonopoly(state, player.userId, sq.colorGroup)) {
    log(state, `${player.username} now has a monopoly on ${sq.colorGroup}!`, 'property');
    events.push(event('MONOPOLY_ACHIEVED', { username: player.username, colorGroup: sq.colorGroup }));
  }

  // Re-allow doubles roll if applicable
  if (state.turnState.doubles > 0 && state.turnState.phase === 'post-roll') {
    state.turnState.phase = 'pre-roll';
  }

  return { state, events };
}

/**
 * Current player declines to buy and triggers an auction.
 */
function declinePurchase(state, userId) {
  const events    = [];
  const playerIdx = state.turnState.currentPlayerIndex;
  const player    = state.players[playerIdx];

  if (player.userId !== userId)           return { state, events, error: 'Not your turn' };
  if (state.turnState.phase !== 'buying') return { state, events, error: 'Not in buying phase' };
  if (!state.config.settings.auctionEnabled) {
    // If auctions disabled, just skip
    state = clone(state);
    state.turnState.phase = 'post-roll';
    return { state, events };
  }

  state = clone(state);
  const position = state.players[playerIdx].position;
  const sq       = state.config.board[position];

  state.auction = {
    position,
    bids:      {},
    passed:    [],
    highBidder: null,
    highBid:   state.config.settings.auctionMinBid - 1,
  };
  state.turnState.phase = 'auctioning';

  log(state, `${sq.name} is up for auction! Starting bid: $${state.config.settings.auctionMinBid}`, 'auction');
  events.push(event('AUCTION_STARTED', { position, name: sq.name, minBid: state.config.settings.auctionMinBid }));

  return { state, events };
}

/**
 * A player places a bid in the current auction.
 */
function placeBid(state, userId, amount) {
  const events = [];

  if (!state.auction) return { state, events, error: 'No auction in progress' };
  if (state.turnState.phase !== 'auctioning') return { state, events, error: 'Not in auctioning phase' };

  const player = state.players.find(p => p.userId === userId);
  if (!player) return { state, events, error: 'Player not found' };
  if (player.isBankrupt) return { state, events, error: 'Bankrupt players cannot bid' };
  if (state.auction.passed.includes(userId)) return { state, events, error: 'You have already passed on this auction' };

  const minBid = Math.max(state.config.settings.auctionMinBid, state.auction.highBid + 1);
  if (amount < minBid) return { state, events, error: `Bid must be at least $${minBid}` };
  if (amount > player.money) return { state, events, error: 'Not enough money for that bid' };

  state = clone(state);
  state.auction.bids[userId]  = amount;
  state.auction.highBid       = amount;
  state.auction.highBidder    = userId;

  log(state, `${player.username} bid $${amount} for ${state.config.board[state.auction.position].name}`, 'auction');
  events.push(event('AUCTION_BID', { username: player.username, amount, position: state.auction.position }));

  return { state, events };
}

/**
 * A player passes on the current auction.  When all active players have
 * passed, the auction resolves.
 */
function passAuction(state, userId) {
  const events = [];

  if (!state.auction) return { state, events, error: 'No auction in progress' };

  const player = state.players.find(p => p.userId === userId);
  if (!player) return { state, events, error: 'Player not found' };

  state = clone(state);
  if (!state.auction.passed.includes(userId)) {
    state.auction.passed.push(userId);
  }

  log(state, `${player.username} passed on the auction`, 'auction');
  events.push(event('AUCTION_PASSED', { username: player.username }));

  // Check if the auction is over (all non-bankrupt players have passed)
  const activePlayers = state.players.filter(p => !p.isBankrupt);
  const allPassed     = activePlayers.every(p => state.auction.passed.includes(p.userId));

  if (allPassed) {
    const result = resolveAuction(state, events);
    state  = result.state;
    events.push(...result.newEvents);
  }

  return { state, events };
}

function resolveAuction(state, existingEvents = []) {
  const newEvents = [];
  const { position, highBidder, highBid } = state.auction;
  const sq = state.config.board[position];

  if (highBidder && highBid >= state.config.settings.auctionMinBid) {
    const winner    = state.players.find(p => p.userId === highBidder);
    const winnerIdx = state.players.findIndex(p => p.userId === highBidder);
    state.players[winnerIdx].money -= highBid;
    state.properties[position].ownerId = highBidder;

    log(state, `${winner.username} won the auction for ${sq.name} at $${highBid}`, 'auction');
    newEvents.push(event('AUCTION_WON', { username: winner.username, position, name: sq.name, amount: highBid }));

    if (sq.type === 'property' && hasMonopoly(state, highBidder, sq.colorGroup)) {
      newEvents.push(event('MONOPOLY_ACHIEVED', { username: winner.username, colorGroup: sq.colorGroup }));
    }
  } else {
    log(state, `No one bid on ${sq.name} — it remains unsold`, 'auction');
    newEvents.push(event('AUCTION_NO_WINNER', { position, name: sq.name }));
  }

  state.auction         = null;
  state.turnState.phase = 'post-roll';

  // Re-allow doubles roll if applicable
  if (state.turnState.doubles > 0) state.turnState.phase = 'pre-roll';

  return { state, newEvents };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a house on a property.  Validates even-building rule and bank limits.
 */
function buildHouse(state, userId, position) {
  const events  = [];
  const player  = state.players.find(p => p.userId === userId);
  if (!player) return { state, events, error: 'Player not found' };

  const sq        = state.config.board[position];
  const propState = state.properties[position];

  if (!propState || sq.type !== 'property')    return { state, events, error: 'Not a property' };
  if (propState.ownerId !== userId)            return { state, events, error: 'You do not own this property' };
  if (propState.mortgaged)                     return { state, events, error: 'Property is mortgaged' };
  if (!hasMonopoly(state, userId, sq.colorGroup)) return { state, events, error: 'You need a monopoly to build' };
  if (propState.houses >= 5)                   return { state, events, error: 'Already has a hotel' };

  // Check even-building rule
  const groupPositions = state.config.colorGroups[sq.colorGroup];
  const minHouses = Math.min(...groupPositions.map(p => state.properties[p].houses));
  if (propState.houses > minHouses) {
    return { state, events, error: 'You must build evenly across the color group' };
  }

  const isHotel = propState.houses === 4;
  const cost    = isHotel ? sq.hotelCost : sq.houseCost;

  if (player.money < cost) return { state, events, error: `Not enough money. Need $${cost}` };

  // Check bank limits
  const inPlay = totalBuildingsInPlay(state);
  if (isHotel && inPlay.hotels >= state.config.settings.maxHotelsInBank) {
    return { state, events, error: 'No hotels available in the bank' };
  }
  if (!isHotel && inPlay.houses >= state.config.settings.maxHousesInBank) {
    return { state, events, error: 'No houses available in the bank' };
  }

  state = clone(state);
  const playerRef = state.players.find(p => p.userId === userId);
  playerRef.money -= cost;
  state.properties[position].houses++;

  const buildingType = state.properties[position].houses === 5 ? 'hotel' : 'house';
  log(state, `${player.username} built a ${buildingType} on ${sq.name}`, 'property');
  events.push(event('BUILDING_BUILT', { username: player.username, position, name: sq.name, buildingType, houses: state.properties[position].houses }));

  return { state, events };
}

/**
 * Sell a house back to the bank at half price.
 */
function sellHouse(state, userId, position) {
  const events  = [];
  const player  = state.players.find(p => p.userId === userId);
  if (!player) return { state, events, error: 'Player not found' };

  const sq        = state.config.board[position];
  const propState = state.properties[position];

  if (!propState || sq.type !== 'property') return { state, events, error: 'Not a property' };
  if (propState.ownerId !== userId)         return { state, events, error: 'You do not own this property' };
  if (propState.houses === 0)               return { state, events, error: 'No buildings to sell' };

  // Check even-selling rule (must sell down evenly)
  const groupPositions = state.config.colorGroups[sq.colorGroup];
  const maxHouses = Math.max(...groupPositions.map(p => state.properties[p].houses));
  if (propState.houses < maxHouses) {
    return { state, events, error: 'You must sell buildings evenly across the color group' };
  }

  const wasHotel  = propState.houses === 5;
  const sellPrice = wasHotel ? Math.floor(sq.hotelCost / 2) : Math.floor(sq.houseCost / 2);

  state = clone(state);
  const playerRef = state.players.find(p => p.userId === userId);
  playerRef.money += sellPrice;
  state.properties[position].houses--;

  const buildingType = wasHotel ? 'hotel' : 'house';
  log(state, `${player.username} sold a ${buildingType} on ${sq.name} for $${sellPrice}`, 'property');
  events.push(event('BUILDING_SOLD', { username: player.username, position, name: sq.name, buildingType, sellPrice }));

  return { state, events };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mortgage a property.  All buildings must be sold first.
 */
function mortgageProperty(state, userId, position) {
  const events  = [];
  const player  = state.players.find(p => p.userId === userId);
  if (!player) return { state, events, error: 'Player not found' };

  const sq        = state.config.board[position];
  const propState = state.properties[position];

  if (!propState)                    return { state, events, error: 'Not a purchasable square' };
  if (propState.ownerId !== userId)  return { state, events, error: 'You do not own this property' };
  if (propState.mortgaged)           return { state, events, error: 'Already mortgaged' };
  if (propState.houses > 0)          return { state, events, error: 'Sell all buildings before mortgaging' };

  state = clone(state);
  state.properties[position].mortgaged = true;
  state.players.find(p => p.userId === userId).money += sq.mortgage;

  log(state, `${player.username} mortgaged ${sq.name} for $${sq.mortgage}`, 'property');
  events.push(event('PROPERTY_MORTGAGED', { username: player.username, position, name: sq.name, amount: sq.mortgage }));

  return { state, events };
}

/**
 * Unmortgage a property (pay mortgage value + 10% interest).
 */
function unmortgageProperty(state, userId, position) {
  const events  = [];
  const player  = state.players.find(p => p.userId === userId);
  if (!player) return { state, events, error: 'Player not found' };

  const sq        = state.config.board[position];
  const propState = state.properties[position];

  if (!propState)                    return { state, events, error: 'Not a purchasable square' };
  if (propState.ownerId !== userId)  return { state, events, error: 'You do not own this property' };
  if (!propState.mortgaged)          return { state, events, error: 'Not mortgaged' };

  const cost = sq.unmortgageCost;
  if (player.money < cost) return { state, events, error: `Need $${cost} to unmortgage (mortgage $${sq.mortgage} + 10% interest)` };

  state = clone(state);
  state.properties[position].mortgaged = false;
  state.players.find(p => p.userId === userId).money -= cost;

  log(state, `${player.username} unmortgaged ${sq.name} for $${cost}`, 'property');
  events.push(event('PROPERTY_UNMORTGAGED', { username: player.username, position, name: sq.name, amount: cost }));

  return { state, events };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * End the current player's turn and advance to the next player.
 */
function endTurn(state, userId) {
  const events    = [];
  const playerIdx = state.turnState.currentPlayerIndex;
  const player    = state.players[playerIdx];

  if (player.userId !== userId) return { state, events, error: 'Not your turn' };
  if (!['post-roll'].includes(state.turnState.phase)) {
    return { state, events, error: 'Cannot end turn right now' };
  }

  state = clone(state);

  // Check for win condition (only one non-bankrupt player left)
  const activePlayers = state.players.filter(p => !p.isBankrupt);
  if (activePlayers.length === 1) {
    state.status = 'finished';
    log(state, `${activePlayers[0].username} wins the game!`, 'game');
    events.push(event('GAME_OVER', { winner: activePlayers[0].username }));
    return { state, events };
  }

  // Find next non-bankrupt player
  let nextIdx = (playerIdx + 1) % state.players.length;
  while (state.players[nextIdx].isBankrupt) {
    nextIdx = (nextIdx + 1) % state.players.length;
  }

  state.turnState = {
    currentPlayerIndex: nextIdx,
    phase:   'pre-roll',
    dice:    [0, 0],
    doubles: 0,
    cardDrawn: null,
  };
  state.trade  = null; // clear any lingering pending trade

  const nextPlayer = state.players[nextIdx];
  log(state, `It is now ${nextPlayer.username}'s turn`, 'turn');
  events.push(event('TURN_ENDED', { username: player.username }));
  events.push(event('TURN_STARTED', { username: nextPlayer.username, playerIndex: nextIdx }));

  return { state, events };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Offer a trade to another player.
 */
function offerTrade(state, fromUserId, toUserId, offerMoney, offerProps, offerCards, requestMoney, requestProps, requestCards) {
  const events = [];

  if (!state.config.settings.tradeEnabled) return { state, events, error: 'Trading is disabled' };
  if (fromUserId === toUserId)              return { state, events, error: 'Cannot trade with yourself' };

  const fromPlayer = state.players.find(p => p.userId === fromUserId);
  const toPlayer   = state.players.find(p => p.userId === toUserId);
  if (!fromPlayer || !toPlayer) return { state, events, error: 'Player not found' };
  if (fromPlayer.isBankrupt || toPlayer.isBankrupt) return { state, events, error: 'Cannot trade with a bankrupt player' };

  // Validate offer
  if (fromPlayer.money < offerMoney) return { state, events, error: 'Not enough money to offer' };
  for (const pos of offerProps) {
    if (state.properties[pos]?.ownerId !== fromUserId) return { state, events, error: `You do not own position ${pos}` };
    if (state.properties[pos]?.houses > 0) return { state, events, error: 'Sell all buildings before trading a property' };
  }
  if (fromPlayer.jailCards < offerCards) return { state, events, error: 'Not enough jail cards to offer' };

  // Validate request
  if (toPlayer.money < requestMoney) return { state, events, error: `${toPlayer.username} does not have enough money` };
  for (const pos of requestProps) {
    if (state.properties[pos]?.ownerId !== toUserId) return { state, events, error: `${toPlayer.username} does not own position ${pos}` };
    if (state.properties[pos]?.houses > 0) return { state, events, error: 'Requested property has buildings — sell them first' };
  }
  if (toPlayer.jailCards < requestCards) return { state, events, error: `${toPlayer.username} does not have enough jail cards` };

  state = clone(state);
  state.trade = {
    fromUserId, toUserId,
    offerMoney, offerProps: offerProps || [], offerCards: offerCards || 0,
    requestMoney, requestProps: requestProps || [], requestCards: requestCards || 0,
    status: 'pending',
  };

  log(state, `${fromPlayer.username} offered a trade to ${toPlayer.username}`, 'trade');
  events.push(event('TRADE_OFFERED', { from: fromPlayer.username, to: toPlayer.username, trade: state.trade }));

  return { state, events };
}

/**
 * Accept a pending trade offer.
 */
function acceptTrade(state, userId) {
  const events = [];

  if (!state.trade || state.trade.status !== 'pending') return { state, events, error: 'No pending trade' };
  if (state.trade.toUserId !== userId) return { state, events, error: 'This trade is not addressed to you' };

  state = clone(state);
  const { fromUserId, toUserId, offerMoney, offerProps, offerCards, requestMoney, requestProps, requestCards } = state.trade;

  const fromIdx = state.players.findIndex(p => p.userId === fromUserId);
  const toIdx   = state.players.findIndex(p => p.userId === toUserId);

  // Exchange money
  state.players[fromIdx].money -= offerMoney;
  state.players[toIdx].money   += offerMoney;
  state.players[toIdx].money   -= requestMoney;
  state.players[fromIdx].money += requestMoney;

  // Exchange properties
  for (const pos of offerProps)   state.properties[pos].ownerId = toUserId;
  for (const pos of requestProps) state.properties[pos].ownerId = fromUserId;

  // Exchange jail cards
  state.players[fromIdx].jailCards -= offerCards;
  state.players[toIdx].jailCards   += offerCards;
  state.players[toIdx].jailCards   -= requestCards;
  state.players[fromIdx].jailCards += requestCards;

  state.trade.status = 'accepted';
  const fromPlayer   = state.players[fromIdx];
  const toPlayer     = state.players[toIdx];

  log(state, `Trade between ${fromPlayer.username} and ${toPlayer.username} was accepted`, 'trade');
  events.push(event('TRADE_ACCEPTED', { from: fromPlayer.username, to: toPlayer.username }));

  state.trade = null;
  return { state, events };
}

/**
 * Reject a pending trade offer.
 */
function rejectTrade(state, userId) {
  const events = [];

  if (!state.trade || state.trade.status !== 'pending') return { state, events, error: 'No pending trade' };
  if (state.trade.toUserId !== userId) return { state, events, error: 'This trade is not addressed to you' };

  state = clone(state);
  const fromPlayer = state.players.find(p => p.userId === state.trade.fromUserId);
  const toPlayer   = state.players.find(p => p.userId === state.trade.toUserId);

  log(state, `${toPlayer.username} rejected ${fromPlayer.username}'s trade offer`, 'trade');
  events.push(event('TRADE_REJECTED', { from: fromPlayer.username, to: toPlayer.username }));

  state.trade = null;
  return { state, events };
}

/**
 * Cancel an outgoing trade offer (by the sender).
 */
function cancelTrade(state, userId) {
  const events = [];

  if (!state.trade || state.trade.status !== 'pending') return { state, events, error: 'No pending trade' };
  if (state.trade.fromUserId !== userId) return { state, events, error: 'This is not your trade offer' };

  state = clone(state);
  const fromPlayer = state.players.find(p => p.userId === userId);

  log(state, `${fromPlayer.username} cancelled their trade offer`, 'trade');
  events.push(event('TRADE_CANCELLED', { username: fromPlayer.username }));

  state.trade = null;
  return { state, events };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Declare a player bankrupt.  Their assets go to their creditor (or the bank).
 */
function declareBankruptcy(state, playerIdx, creditorUserId) {
  const events  = [];
  const player  = state.players[playerIdx];

  state = clone(state);
  state.players[playerIdx].isBankrupt = true;

  // Transfer all assets to creditor or return to bank
  for (const [pos, propState] of Object.entries(state.properties)) {
    if (propState.ownerId === player.userId) {
      if (creditorUserId) {
        // Transfer to creditor (mortgaged properties transfer as-is with 10% fee)
        propState.ownerId = creditorUserId;
        if (propState.mortgaged) {
          const creditorIdx = state.players.findIndex(p => p.userId === creditorUserId);
          const interestFee = Math.floor(state.config.board[Number(pos)].mortgage * 0.1);
          if (state.players[creditorIdx].money >= interestFee) {
            state.players[creditorIdx].money -= interestFee;
          }
        }
      } else {
        // Return to bank
        propState.ownerId  = null;
        propState.houses   = 0;
        propState.mortgaged = false;
      }
    }
  }

  // Transfer remaining money
  if (creditorUserId) {
    const creditorIdx = state.players.findIndex(p => p.userId === creditorUserId);
    if (creditorIdx >= 0) {
      state.players[creditorIdx].money += state.players[playerIdx].money;
    }
  }
  state.players[playerIdx].money = 0;

  // Transfer jail cards
  if (creditorUserId && player.jailCards > 0) {
    const creditorIdx = state.players.findIndex(p => p.userId === creditorUserId);
    if (creditorIdx >= 0) state.players[creditorIdx].jailCards += player.jailCards;
  }
  state.players[playerIdx].jailCards = 0;

  log(state, `${player.username} is bankrupt!`, 'game');
  events.push(event('PLAYER_BANKRUPT', { username: player.username }));

  // Check for game over
  const remaining = state.players.filter(p => !p.isBankrupt);
  if (remaining.length === 1) {
    state.status = 'finished';
    log(state, `${remaining[0].username} wins the game!`, 'game');
    events.push(event('GAME_OVER', { winner: remaining[0].username }));
  }

  return { state, events };
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initGame,
  rollDice,
  payJailFine,
  useJailCard,
  buyProperty,
  declinePurchase,
  placeBid,
  passAuction,
  buildHouse,
  sellHouse,
  mortgageProperty,
  unmortgageProperty,
  endTurn,
  offerTrade,
  acceptTrade,
  rejectTrade,
  cancelTrade,
  declareBankruptcy,
  calculateRent,
  playerNetWorth,
};
