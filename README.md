# 🎲 LAN Games — Turn-Based Multiplayer Engine

A **multi-game, browser-based multiplayer platform** for your local network.  
Drop in any turn-based game by implementing a single interface; the framework handles lobbies, persistence, real-time sync, chat, and save/resume automatically.

Built with **Node.js · Express · Socket.io** (server) and **vanilla HTML/CSS/JavaScript** (client).

**Bundled games:** Monopoly (2–8 players) · Connect Four (2 players)

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Project Structure](#project-structure)
4. [How to Play](#how-to-play)
   - [Monopoly](#monopoly)
   - [Connect Four](#connect-four)
5. [Adding a New Game](#adding-a-new-game)
6. [Architecture](#architecture)
7. [Configuration](#configuration)
   - [Monopoly Settings](#monopoly-settings)
   - [Monopoly Board](#monopoly-board--properties)
   - [Monopoly Cards](#monopoly-cards)
   - [Connect Four Settings](#connect-four-settings)
8. [API Reference](#api-reference)
9. [Socket.io Events](#socketio-events)
10. [Security Notes](#security-notes)
11. [Development](#development)
12. [Roadmap](#roadmap)

---

## Features

### Framework
- **Multi-game** — add any turn-based game by implementing one interface file; no framework changes required
- **Real-time multiplayer** — all clients sync instantly via Socket.io WebSockets
- **Player accounts** — register/login with username + password; JWT persisted in `localStorage`
- **Lobby** — create, browse, and join open games; game-type badge shown on every card
- **Save & Resume** — pause any in-progress game and continue it later from the lobby
- **Auto-reconnect** — disconnected players are marked AFK; their turn is auto-skipped after 30 s
- **In-game chat** — room-scoped, real-time, 300-character cap
- **Configurable** — every rule, price, and board value lives in JSON; hot-reload without a restart

### Monopoly
- Full rules: dice, doubles (3× → jail), property buying, auctions, rent, color-group monopoly detection, even-building rule, mortgage/unmortgage, jail (fine / doubles / card), Chance & Community Chest (full 16-card decks), trades (money + properties + jail cards), Income Tax (flat or 10% of net worth), bankruptcy with asset transfer
- Visual CSS Grid board with color bands, player tokens, house/hotel indicators, and ownership dots

### Connect Four
- Standard 7 × 6 board; drop pieces by clicking column buttons
- Win detection: horizontal, vertical, and both diagonals
- Draw detection when the board is full

---

## Quick Start

### Prerequisites

- **Node.js 18+** (LTS recommended)
- No external database — SQLite is embedded via `better-sqlite3`

### Install & run

```bash
cd server
npm install
npm start          # production
npm run dev        # development (nodemon auto-restart)
```

The server binds to `0.0.0.0:3000` by default — reachable on your entire LAN.

### Connect

| Who | URL |
|-----|-----|
| Host machine | `http://localhost:3000` |
| LAN players | `http://<host-ip>:3000` |

Find `<host-ip>` with `ip addr` (Linux/macOS) or `ipconfig` (Windows).

### Play

1. Every player registers a username and password on their own browser.
2. One player creates a game, picks a game type, and optionally customises rules.
3. Other players join from the lobby.
4. The host clicks **Start Game**.

---

## Project Structure

```
lan-games/
├── README.md
│
├── server/
│   ├── package.json
│   ├── scripts/
│   │   └── reset-db.js           ← wipe the database (--hard to also delete the file)
│   ├── data/                     ← created at runtime; holds lan-games.db (gitignored)
│   │
│   ├── games/                    ← one subdirectory per game type
│   │   ├── monopoly/
│   │   │   ├── game-logic.js     ← all Monopoly rules (pure functions)
│   │   │   ├── config-loader.js  ← loads & validates the three Monopoly config files
│   │   │   └── config/
│   │   │       ├── board.json    ← 40 board squares (names, prices, rents)
│   │   │       ├── cards.json    ← Chance & Community Chest decks
│   │   │       └── settings.json ← game rules (starting money, jail fine, …)
│   │   └── connect-four/
│   │       ├── game-logic.js     ← Connect Four rules (pure functions)
│   │       └── config/
│   │           └── settings.json ← board dimensions, win length, colours
│   │
│   └── src/                      ← game-agnostic framework
│       ├── index.js              ← entry point; HTTP + Socket.io server
│       ├── database.js           ← SQLite schema + query helpers (better-sqlite3)
│       ├── auth.js               ← bcrypt password hashing + JWT middleware
│       ├── game-logic-interface.js ← interface contract + validateImplementation()
│       ├── game-registry.js      ← maps game-type keys → logic modules
│       ├── game-manager.js       ← in-memory sessions + SQLite persistence
│       ├── socket-handler.js     ← Socket.io event routing
│       └── routes/
│           ├── auth.routes.js    ← /api/auth/*
│           └── game.routes.js    ← /api/games/*
│
└── client/
    ├── index.html                ← single-page application shell
    ├── css/
    │   └── main.css              ← all styles (dark green theme)
    └── js/
        ├── api.js                ← fetch() wrapper for REST calls
        ├── game-state.js         ← client-side state singleton
        ├── board-renderer.js     ← Monopoly CSS Grid board builder & updater
        ├── ui-manager.js         ← all DOM updates outside the board
        ├── socket-client.js      ← Socket.io connection + event dispatch
        ├── sound-manager.js      ← audio cues
        ├── app.js                ← wires modules + DOM event listeners
        └── games/
            └── connect-four/
                └── renderer.js   ← Connect Four grid builder & updater
```

---

## How to Play

### Monopoly

#### Your turn

1. **Roll Dice** — moves your token; doubles let you roll again.
2. **Unowned property** — buy it or let it go to auction.
3. **Owned property** — rent is collected automatically.
4. **Chance / Community Chest** — card drawn and resolved automatically.
5. **Go to Jail** — landing on "Go to Jail" or rolling three consecutive doubles.
6. **End Turn** — passes to the next player.

#### Anytime on your turn (pre-roll or post-roll)

- **Manage Properties** — click any board square or the "Manage Properties" button to build houses/hotels or mortgage/unmortgage.
- **Propose Trade** — offer money, properties, and Get Out of Jail Free cards in any combination.
- **Declare Bankruptcy** — if you cannot pay a debt, all your assets transfer to the creditor (or the bank).

#### Jail

- Roll doubles to escape for free.
- Pay the $50 fine before rolling (configurable).
- Use a Get Out of Jail Free card.
- After 3 failed turns you must pay the fine and roll.

#### Winning

Last player standing (not bankrupt) wins.

---

### Connect Four

Click a **▼** button above any column to drop your piece.  
The game alternates turns automatically.  
**Win** by connecting 4 of your pieces in a row — horizontally, vertically, or diagonally.  
**Draw** when the board fills with no winner.

---

## Adding a New Game

The framework is intentionally game-agnostic. Adding a new game requires three steps:

### 1. Create `server/games/<your-game>/`

```
server/games/my-game/
├── game-logic.js
└── config/
    └── settings.json   (or however many config files you need)
```

### 2. Implement the GameLogic interface

`game-logic.js` must export all **required** methods. See [`server/src/game-logic-interface.js`](server/src/game-logic-interface.js) for the full JSDoc contract. Verify compliance at load time with `validateImplementation`:

```js
'use strict';

// ... your game logic ...

module.exports = {
  // ── Required ──────────────────────────────────────────────────────
  initGame,            // (gameId, name, players, config) → GameState
  createInitialPlayer, // (user, existingPlayers, config) → PlayerObject
  applyAction,         // (state, userId, action, payload) → ActionResult
  skipTurn,            // (state, userId) → ActionResult
  getCurrentPlayer,    // (state) → { userId, username } | null
  isTurnTimerBlocked,  // (state) → boolean
  getValidActions,     // (state, userId) → string[]
  getGameMetadata,     // () → { name, minPlayers, maxPlayers, description, icon }
  loadConfig,          // () → config object
  getConfigCopy,       // () → deep-cloned config object

  // ── Optional ──────────────────────────────────────────────────────
  getStateForPlayer,   // (state, userId) → filtered state (for hidden-information games)
};

// Throws if any required method is missing
const { validateImplementation } = require('../../src/game-logic-interface');
validateImplementation(module.exports);
```

**Key contracts:**

| Rule | Detail |
|------|--------|
| Pure functions | No I/O, no global mutation, no side effects |
| Immutable input | Never mutate `state` — always return a **new** object |
| In-band errors | Return `{ state, events: [], error: 'reason' }` instead of throwing |
| JSON-safe | `state` must survive `JSON.stringify` → `JSON.parse` |

### 3. Register in `game-registry.js`

```js
// server/src/game-registry.js
const registry = {
  monopoly:      require('../games/monopoly/game-logic'),
  'connect-four': require('../games/connect-four/game-logic'),
  'my-game':     require('../games/my-game/game-logic'),  // ← add this line
};
```

That's it. The framework automatically:
- Exposes the game in `GET /api/games/types`
- Adds it to the client's game-type dropdown
- Routes all `game:action` socket events through your `applyAction`
- Saves and resumes game state via SQLite
- Runs the 30-second disconnect / turn-skip timer

### 4. (Optional) Add a client renderer

If your game has a visual board, create `client/js/games/<your-game>/renderer.js` and branch on `state.gameType` in `app.js` and `socket-client.js`, following the pattern established by `ConnectFourRenderer`.

---

## Architecture

### Component overview

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                    │
│  api.js ──── REST calls ────────────────────────────┐   │
│  socket-client.js ── Socket.io ──────────────────┐  │   │
│  board-renderer.js / connect-four/renderer.js    │  │   │
│  ui-manager.js · app.js · game-state.js          │  │   │
└──────────────────────────────────────────────────┼──┼───┘
                                                   │  │
                         WebSocket (Socket.io)     │  │  HTTP REST
                                                   ▼  ▼
┌─────────────────────────────────────────────────────────┐
│                    Node.js Server                       │
│                                                         │
│  socket-handler.js                                      │
│    └── game-manager.applyAction()                       │
│           └── game-registry.getGameLogic(gameType)      │
│                  └── game-logic.applyAction()  ◄──────  │
│                        (pure function)                  │
│                                                         │
│  game-manager.js ──── persist ───► database.js (SQLite) │
│  auth.js (bcrypt + JWT)                                 │
│  routes/ (Express REST)                                 │
└─────────────────────────────────────────────────────────┘
```

### Data flow for a game action

```
1. Player clicks a button
      ↓
2. socket-client.js emits:  game:action  { action: 'rollDice' }
      ↓
3. socket-handler.js receives the event
      ↓
4. game-manager.applyAction(gameId, userId, 'rollDice', payload)
      ↓
5. game-registry.getGameLogic(state.gameType)  →  returns the correct module
      ↓
6. gameLogic.applyAction(state, userId, 'rollDice', payload)
      →  returns { state: newState, events: [...] }   (pure, no side effects)
      ↓
7. game-manager stores newState in memory + SQLite
      ↓
8. socket-handler broadcasts to the game room:
      io.to(gameId).emit('game:update', { state: newState, events })
      ↓
9. Every client's socket-client.js receives game:update
      ↓
10. UI updates: board, player panels, action buttons, game log, sounds
```

### Database schema

```sql
users (
  id            TEXT PRIMARY KEY,   -- UUID
  username      TEXT UNIQUE,
  password_hash TEXT,               -- bcrypt, 12 rounds
  created_at    INTEGER             -- Unix ms
)

games (
  id          TEXT PRIMARY KEY,     -- UUID
  name        TEXT,
  game_type   TEXT DEFAULT 'monopoly',
  status      TEXT,                 -- waiting | playing | paused | finished
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER,
  updated_at  INTEGER,
  state       TEXT,                 -- JSON-serialised GameState
  config      TEXT                  -- JSON-serialised config (snapshot at game start)
)

game_players (
  game_id   TEXT REFERENCES games(id) ON DELETE CASCADE,
  user_id   TEXT REFERENCES users(id),
  joined_at INTEGER,
  PRIMARY KEY (game_id, user_id)
)
```

### GameState shape (common fields)

Every game state object carries these top-level fields, regardless of game type:

```js
{
  id:         string,         // UUID — matches games.id
  name:       string,         // human-readable game name
  gameType:   string,         // 'monopoly' | 'connect-four' | …
  createdBy:  string,         // userId of the host
  status:     'waiting' | 'playing' | 'paused' | 'finished',
  config:     object,         // full config snapshot (game-specific shape)
  minPlayers: number,         // from getGameMetadata() — used by the waiting-room UI
  maxPlayers: number,
  players:    PlayerObject[], // game-specific player records
  turnState:  object,         // game-specific turn tracking
  winner:     string | null,  // userId of winner, null for draw, undefined if Monopoly-style
  log:        LogEntry[],     // [{ message, type, timestamp }]
}
```

---

## Configuration

Each game owns its configuration under `server/games/<game>/config/`. The server reads these files on startup and validates them; existing in-progress games are not affected by config changes (the config is embedded in the state at game-start time). Hot-reload a game's config without a server restart via:

```
POST /api/games/types/:type/config/reload
```

---

### Monopoly Settings

`server/games/monopoly/config/settings.json`

| Key | Default | Description |
|-----|---------|-------------|
| `startingMoney` | 1500 | Amount each player starts with |
| `goSalary` | 200 | Amount collected when passing or landing on Go |
| `incomeTaxAmount` | 200 | Flat income tax option |
| `incomeTaxPercent` | 10 | Percent-of-net-worth income tax option |
| `incomeTaxChoice` | true | If `true`, player chooses whichever is lower |
| `luxuryTaxAmount` | 100 | Luxury Tax amount |
| `jailFine` | 50 | Cost to pay your way out of jail |
| `jailMaxTurns` | 3 | Turns in jail before the fine becomes mandatory |
| `maxHousesInBank` | 32 | Total houses the bank can supply |
| `maxHotelsInBank` | 12 | Total hotels the bank can supply |
| `auctionEnabled` | true | Auction when a player declines to buy |
| `auctionMinBid` | 1 | Minimum opening bid |
| `freeParkingJackpot` | false | Taxes and fines accumulate on Free Parking |
| `maxPlayers` | 8 | Maximum players per game |
| `minPlayersToStart` | 2 | Minimum players to start |
| `tradeEnabled` | true | Allow player-to-player trades |
| `bankruptcyToBank` | true | Bankrupt assets go to the bank, not the creditor |

---

### Monopoly Board / Properties

`server/games/monopoly/config/board.json` — array of 40 objects, one per square (index 0 = Go, 39 = last square).

**Property square**
```json
{
  "position":       1,
  "type":           "property",
  "name":           "Mediterranean Avenue",
  "colorGroup":     "brown",
  "price":          60,
  "houseCost":      50,
  "hotelCost":      50,
  "mortgage":       30,
  "unmortgageCost": 33,
  "rent": {
    "base":        2,
    "monopoly":    4,
    "oneHouse":    10,
    "twoHouses":   30,
    "threeHouses": 90,
    "fourHouses":  160,
    "hotel":       250
  }
}
```

**Railroad square**
```json
{
  "position": 5,
  "type":     "railroad",
  "name":     "Reading Railroad",
  "price":    200,
  "mortgage": 100,
  "unmortgageCost": 110,
  "rent": { "owned1": 25, "owned2": 50, "owned3": 100, "owned4": 200 }
}
```

**Utility square**
```json
{
  "position": 12,
  "type":     "utility",
  "name":     "Electric Company",
  "price":    150,
  "mortgage": 75,
  "unmortgageCost": 83,
  "rent": { "multiplier1": 4, "multiplier2": 10 }
}
```

---

### Monopoly Cards

`server/games/monopoly/config/cards.json` — two arrays: `chance` and `communityChest` (16 cards each).

```json
{
  "id":     "ch_advance_go",
  "text":   "Advance to Go. Collect $200.",
  "action": "advance_to",
  "data":   { "position": 0, "collectGoSalary": true }
}
```

**Supported `action` values:**

| Action | `data` fields | Effect |
|--------|---------------|--------|
| `advance_to` | `position`, `collectGoSalary` | Move token to board position |
| `advance_to_nearest` | `type` (`railroad`/`utility`), `collectGoSalary`, `rentMultiplier` | Move to nearest of that type |
| `collect` | `amount` | Player receives money from bank |
| `pay` | `amount` | Player pays bank |
| `pay_each_player` | `amount` | Player pays every other player |
| `collect_from_each_player` | `amount` | Player collects from every other player |
| `go_to_jail` | — | Send to jail immediately |
| `get_out_of_jail` | — | Player receives a Get Out of Jail Free card |
| `go_back` | `spaces` | Move back N spaces |
| `repairs` | `houseCost`, `hotelCost` | Charge per house and per hotel owned |

The deck reshuffles automatically when exhausted.

---

### Connect Four Settings

`server/games/connect-four/config/settings.json`

| Key | Default | Description |
|-----|---------|-------------|
| `boardWidth` | 7 | Number of columns |
| `boardHeight` | 6 | Number of rows |
| `winLength` | 4 | Pieces in a row required to win |
| `playerColors` | red, yellow | Array of `{ id, hex }` colour objects |
| `playerTokens` | 🔴, 🟡 | Emoji tokens shown in the player panel |

---

## API Reference

All endpoints live under `/api`. Authenticated endpoints (`✓`) require:

```
Authorization: Bearer <jwt-token>
```

### Auth

| Method | Path | Auth | Body | Response |
|--------|------|:----:|------|----------|
| POST | `/api/auth/register` | | `{ username, password }` | `{ token, user }` |
| POST | `/api/auth/login` | | `{ username, password }` | `{ token, user }` |
| GET | `/api/auth/me` | ✓ | — | `{ id, username }` |

### Games

| Method | Path | Auth | Body | Response |
|--------|------|:----:|------|----------|
| GET | `/api/games` | ✓ | — | `{ games[] }` — open & in-progress |
| GET | `/api/games/saved` | ✓ | — | `{ games[] }` — paused games for current user |
| GET | `/api/games/mine` | ✓ | — | `{ games[] }` — active games the user is in |
| GET | `/api/games/types` | ✓ | — | `{ types[] }` — registered game types + metadata |
| GET | `/api/games/types/:type/config` | ✓ | — | `{ config }` — default config for game type |
| POST | `/api/games/types/:type/config/reload` | ✓ | — | `{ success, config }` — hot-reload from disk |
| GET | `/api/games/config/default` | ✓ | — | `{ config }` — alias for Monopoly default config |
| POST | `/api/games` | ✓ | `{ name, gameType?, configOverrides? }` | `{ gameId, state }` |
| GET | `/api/games/:id` | ✓ | — | `{ state }` |
| POST | `/api/games/:id/join` | ✓ | — | `{ state }` |
| POST | `/api/games/:id/start` | ✓ (host) | — | `{ state }` |
| POST | `/api/games/:id/save` | ✓ (host) | — | `{ success }` |
| DELETE | `/api/games/:id` | ✓ (host) | — | `{ success }` |

`configOverrides` follows the same shape as the game's `settings.json` and is merged at game-creation time. Only `waiting` and `paused` games can be deleted.

---

## Socket.io Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join_game` | `gameId` | Join the Socket.io room for a game; server replies with full state |
| `leave_game` | — | Leave current game room |
| `lobby:join` | `gameId` | Join a waiting-room lobby (adds player to the roster) |
| `game:start` | — | Host starts the game |
| `game:action` | `{ action, ...payload }` | **Universal action event** — all player moves use this single event |
| `game:save` | — | Save (pause) the current game |
| `chat:message` | `{ text }` | Send a chat message to the game room |

#### `game:action` — action names by game

**Monopoly**

| `action` | Extra payload | Effect |
|----------|--------------|--------|
| `rollDice` | — | Roll and move |
| `buyProperty` | — | Buy the current square |
| `declinePurchase` | — | Decline; triggers auction if enabled |
| `placeBid` | `{ amount }` | Place a bid in an ongoing auction |
| `passAuction` | — | Pass on the current auction |
| `endTurn` | — | End the current turn |
| `payJailFine` | — | Pay to leave jail |
| `useJailCard` | — | Use a Get Out of Jail Free card |
| `buildHouse` | `{ position }` | Build a house or hotel |
| `sellHouse` | `{ position }` | Sell a house or hotel |
| `mortgageProperty` | `{ position }` | Mortgage a property |
| `unmortgageProperty` | `{ position }` | Unmortgage a property |
| `offerTrade` | `{ toUserId, offerMoney, offerProps, offerCards, requestMoney, requestProps, requestCards }` | Propose a trade |
| `acceptTrade` | — | Accept a pending trade offer |
| `rejectTrade` | — | Reject a pending trade offer |
| `cancelTrade` | — | Cancel an outgoing trade offer |
| `declareBankruptcy` | — | Eliminate yourself and transfer assets |

**Connect Four**

| `action` | Extra payload | Effect |
|----------|--------------|--------|
| `dropPiece` | `{ column }` | Drop a piece into the given column (0-indexed) |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `game:state` | `{ state }` | Full state sync — sent on join or reconnect |
| `game:update` | `{ state, events[] }` | Incremental update after every action |
| `game:error` | `{ message }` | Action rejected — sent only to the acting socket |
| `game:saved` | `{ savedBy }` | Game was saved |
| `trade:incoming` | `{ from, payload }` | Targeted directly to the trade recipient |
| `chat:message` | `{ username, text, timestamp }` | Chat message broadcast to the room |
| `lobby:update` | — | Broadcast to all sockets; clients on the lobby screen refresh their game list |
| `game:turn_warning` | `{ username, secondsRemaining }` | Disconnected player's turn will auto-skip |
| `auth:error` | `{ message }` | Auth failure; socket is disconnected after this |

#### Game events (inside `game:update → events[]`)

Each event has `{ type, data, timestamp }`. Clients use these for sounds, animations, and log entries.

| `type` | Notable `data` fields |
|--------|-----------------------|
| `DICE_ROLLED` | `die1`, `die2`, `doubles` |
| `PLAYER_MOVED` | `username`, `from`, `to` |
| `PLAYER_LANDED` | `username`, `squareName` |
| `PASSED_GO` | `username`, `amount` |
| `PROPERTY_BOUGHT` | `username`, `name`, `price` |
| `AUCTION_STARTED` | `name`, `position`, `minBid` |
| `AUCTION_WON` | `username`, `name`, `amount` |
| `MONOPOLY_ACHIEVED` | `username`, `colorGroup` |
| `RENT_PAID` | `from`, `to`, `amount` |
| `CARD_DRAWN` | `username`, `card` |
| `BUILDING_BUILT` | `username`, `name`, `buildingType` |
| `TRADE_OFFERED` | `from`, `to` |
| `TRADE_ACCEPTED` | `from`, `to` |
| `PLAYER_BANKRUPT` | `username` |
| `PLAYER_JAILED` | `username` |
| `TURN_SKIPPED` | `username` |
| `PIECE_DROPPED` | `username`, `column`, `row` |
| `GAME_OVER` | `winner` (username or `null` for draw) |

---

## Security Notes

- **JWT Secret** — set `JWT_SECRET` in the environment before any public-facing deployment. The server logs a warning and uses an insecure default if the variable is absent.
  ```bash
  JWT_SECRET=<long-random-string> npm start
  ```
- **LAN only** — CORS is `*` and the server binds to all interfaces. Do **not** expose this to the public internet without adding HTTPS, rate limiting, and a firewall.
- **Passwords** — hashed with bcrypt at 12 salt rounds; plaintext is never stored or logged.
- **Server-side validation** — every action is validated on the server before being applied. Clients cannot manipulate state directly or spoof another player's moves.

---

## Development

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port |
| `HOST` | `0.0.0.0` | Bind address |
| `JWT_SECRET` | *(insecure default)* | JWT signing secret |
| `JWT_EXPIRES` | `7d` | JWT token lifetime |

### Scripts

```bash
npm start              # run the server
npm run dev            # run with nodemon (auto-restart on file changes)
npm test               # run Jest test suite (server/test/)
npm run reset-db       # drop all tables and recreate schema
npm run reset-db:hard  # delete the .db file entirely and recreate it
```

### Tests

```bash
cd server
npm test
# → 70 tests, all game-logic unit tests for Monopoly
```

Tests live in `server/test/`. They import game-logic modules directly and never touch the network, database, or socket layer — making them fast and reliable.

### Hot-reloading config

After editing a JSON config file:

```bash
curl -X POST http://localhost:3000/api/games/types/monopoly/config/reload \
     -H "Authorization: Bearer <token>"
```

Only games created *after* the reload will use the new config. In-progress games carry their own embedded snapshot.

### Adding a game — quick checklist

- [ ] `server/games/<name>/game-logic.js` — implements all required interface methods; calls `validateImplementation` at the bottom
- [ ] `server/games/<name>/config/settings.json` — minimum viable config
- [ ] `server/src/game-registry.js` — one new line in the `registry` object
- [ ] (optional) `client/js/games/<name>/renderer.js` — visual board renderer
- [ ] (optional) Branch `enterGameScreen` in `client/js/app.js` and `handleFullStateUpdate` in `client/js/socket-client.js` for the renderer

---

## Roadmap

- **More games** — Chess, Checkers, Scrabble, Catan, Coup, …
- **Turn timer UI** — countdown bar visible to all players during a disconnected player's timeout
- **Spectator mode** — join a game room as a read-only observer
- **Per-game renderer protocol** — formal client-side interface so game renderers can be self-contained drop-ins
- **AI players** — pluggable bot interface implementing the same `applyAction` contract
- **Custom board themes** — CSS variable overrides per game type
- **Mobile optimisation** — touch-friendly controls for handheld players
- **HTTPS / mDNS** — easier LAN discovery and secure transport without manual IP lookup
