# 🎲 Monopoly — Local Network Multiplayer

A fully-featured, browser-based Monopoly game for 2–8 players on your local network.
Built with **Node.js + Express + Socket.io** (server) and **vanilla HTML/CSS/JavaScript** (client).

---

## Table of Contents

1. [Features](#features)
2. [Project Structure](#project-structure)
3. [Quick Start](#quick-start)
4. [How to Play](#how-to-play)
5. [Configuration](#configuration)
   - [Game Settings](#game-settings-serverconfigsettingsjson)
   - [Board / Properties](#board--properties-serverconfigboardjson)
   - [Cards](#cards-serverconfgcardsjson)
6. [Architecture Overview](#architecture-overview)
7. [API Reference](#api-reference)
8. [Socket.io Events](#socketio-events)
9. [Security Notes](#security-notes)
10. [Development](#development)
11. [Known Limitations & Future Ideas](#known-limitations--future-ideas)

---

## Features

- **Real-time multiplayer** — all clients update instantly via Socket.io WebSockets
- **Full Monopoly rules** implemented:
  - Dice rolling, doubles, three-doubles-to-jail
  - Property buying, rent calculation (all tiers)
  - Color-group monopoly detection
  - House and hotel building (even-building rule enforced)
  - Mortgage / unmortgage
  - Jail mechanics (pay fine, roll doubles, use card)
  - Chance and Community Chest cards (full 16-card decks)
  - Auctions when a player declines to buy
  - Trades (money + properties + Get Out of Jail Free cards)
  - Bankruptcy and asset transfer
  - Income Tax (flat or 10% of net worth, player chooses)
- **Player accounts** — register/login with username + password; JWT auth persisted in `localStorage`
- **Save & Resume** — pause a game and continue it later
- **Configurable** — every property name, price, rent amount, card text, and game rule is defined in editable JSON files (no code changes needed)
- **In-game chat**
- **Visual board** — CSS Grid board with color bands, player tokens, house/hotel indicators, ownership dots
- **Responsive** — scales for smaller screens

---

## Project Structure

```
monopoly-cs/
├── .gitignore
├── README.md
│
├── server/
│   ├── package.json
│   ├── config/
│   │   ├── board.json        ← 40 board squares (names, prices, rents)
│   │   ├── cards.json        ← Chance and Community Chest decks
│   │   └── settings.json     ← Game settings (starting money, rules)
│   ├── data/                 ← Created at runtime; holds monopoly.db
│   └── src/
│       ├── index.js          ← Entry point; starts HTTP + Socket.io server
│       ├── database.js       ← SQLite setup (better-sqlite3)
│       ├── auth.js           ← bcrypt + JWT utilities + middleware
│       ├── config-loader.js  ← Loads & validates JSON config files
│       ├── game-logic.js     ← Pure Monopoly game engine (all rules)
│       ├── game-manager.js   ← Stateful game session management + DB sync
│       ├── socket-handler.js ← Socket.io real-time event handling
│       └── routes/
│           ├── auth.routes.js  ← POST /api/auth/{register,login} + GET /me
│           └── game.routes.js  ← CRUD for games + config endpoints
│
└── client/
    ├── index.html            ← Single-page application shell
    ├── css/
    │   └── main.css          ← All styles (dark green felt theme)
    └── js/
        ├── api.js            ← fetch() wrapper for REST calls
        ├── game-state.js     ← Client-side state store (singleton)
        ├── board-renderer.js ← CSS Grid board builder + live updater
        ├── ui-manager.js     ← All DOM updates outside the board
        ├── socket-client.js  ← Socket.io event handling + action emitters
        └── app.js            ← Entry point; wires modules + DOM events
```

---

## Quick Start

### Prerequisites

- **Node.js 18+** (any modern LTS release)
- No database server required (SQLite is embedded)

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Start the server

```bash
npm start
# or for development with auto-restart:
npm run dev
```

The server listens on **port 3000** by default and binds to all network interfaces (`0.0.0.0`), so players on your LAN can reach it.

### 3. Open the game

- **Host machine:** open `http://localhost:3000`
- **Other LAN players:** open `http://<host-machine-IP>:3000`
  - Find your IP with `ip addr` (Linux/Mac) or `ipconfig` (Windows)

### 4. Register and play

1. Each player registers a username and password on their own browser.
2. One player creates a game (optionally customizing rules).
3. Other players join from the lobby.
4. The host clicks **Start Game**.

---

## How to Play

### Your Turn

1. **Roll Dice** — click "Roll Dice" to move your token.
2. **Land on an unowned property** — choose to buy it or let it go to auction.
3. **Land on a property owned by another player** — rent is collected automatically.
4. **Land on Chance or Community Chest** — a card is drawn and resolved automatically.
5. **Land on Go to Jail** — you're sent to jail immediately.
6. **End Turn** — click "End Turn" to pass to the next player.

### Anytime on Your Turn (before or after rolling)

- **Manage Properties** — click any square on the board or "Manage Properties" to build houses/hotels or mortgage/unmortgage.
- **Propose Trade** — offer another player money, properties, or jail cards in exchange for theirs.
- **Declare Bankruptcy** — if you can't pay a debt.

### Jail

- To get out: roll doubles on your turn, pay the $50 fine before rolling, or use a Get Out of Jail Free card.
- After 3 turns in jail you must pay the $50 fine and roll.

### Winning

The last player who is not bankrupt wins the game.

---

## Configuration

All game data lives in `server/config/`. Edit these JSON files to customize the game. The server reads them on startup; after editing, restart the server or call `POST /api/games/config/reload` to hot-reload.

### Game Settings — `server/config/settings.json`

| Key | Default | Description |
|-----|---------|-------------|
| `startingMoney` | 1500 | Amount each player starts with |
| `goSalary` | 200 | Amount collected when passing Go |
| `incomeTaxAmount` | 200 | Flat income tax option |
| `incomeTaxPercent` | 10 | Percent-of-net-worth income tax option |
| `incomeTaxChoice` | true | If true, player pays whichever is less |
| `luxuryTaxAmount` | 100 | Luxury tax (Boardwalk side) |
| `jailFine` | 50 | Cost to pay your way out of jail |
| `jailMaxTurns` | 3 | Turns in jail before mandatory fine |
| `maxHousesInBank` | 32 | Total houses the bank can supply |
| `maxHotelsInBank` | 12 | Total hotels the bank can supply |
| `auctionEnabled` | true | Auction unbuilt properties when declined |
| `auctionMinBid` | 1 | Minimum opening bid in an auction |
| `freeParkingJackpot` | false | Taxes/fines accumulate on Free Parking |
| `maxPlayers` | 8 | Maximum players per game |
| `minPlayersToStart` | 2 | Minimum players needed to start |
| `tradeEnabled` | true | Allow trades between players |
| `bankruptcyToBank` | true | Bankrupt assets go to bank (not creditor) |

### Board / Properties — `server/config/board.json`

An array of 40 objects, one per board square, in order (0 = Go, 39 = Boardwalk).

**Property square fields:**

```json
{
  "position":   1,
  "type":       "property",
  "name":       "Mediterranean Avenue",
  "colorGroup": "brown",
  "price":      60,
  "houseCost":  50,
  "hotelCost":  50,
  "mortgage":   30,
  "unmortgageCost": 33,
  "rent": {
    "base":       2,
    "monopoly":   4,
    "oneHouse":   10,
    "twoHouses":  30,
    "threeHouses":90,
    "fourHouses": 160,
    "hotel":      250
  }
}
```

**Railroad square fields:**

```json
{
  "position": 5,
  "type":     "railroad",
  "name":     "Reading Railroad",
  "price":    200,
  "mortgage": 100,
  "unmortgageCost": 110,
  "rent": {
    "owned1": 25,
    "owned2": 50,
    "owned3": 100,
    "owned4": 200
  }
}
```

**Utility square fields:**

```json
{
  "position": 12,
  "type":     "utility",
  "name":     "Electric Company",
  "price":    150,
  "mortgage": 75,
  "unmortgageCost": 83,
  "rent": {
    "multiplier1": 4,
    "multiplier2": 10
  }
}
```

You can rename any property, adjust any price, and change any rent amount simply by editing this file.

### Cards — `server/config/cards.json`

Contains two arrays: `chance` (16 cards) and `communityChest` (16 cards).

Each card has:

```json
{
  "id":     "ch_advance_go",
  "text":   "Advance to Go. Collect $200.",
  "action": "advance_to",
  "data":   { "position": 0, "collectGoSalary": true }
}
```

**Supported `action` values:**

| Action | Data fields | Effect |
|--------|-------------|--------|
| `advance_to` | `position`, `collectGoSalary` | Move token to board position |
| `advance_to_nearest` | `type` (railroad/utility), `collectGoSalary`, `rentMultiplier` | Move to nearest of type |
| `collect` | `amount`, `source` | Player receives money from bank |
| `pay` | `amount`, `recipient` | Player pays bank |
| `pay_each_player` | `amount` | Player pays every other player |
| `collect_from_each_player` | `amount` | Player collects from every other player |
| `go_to_jail` | — | Send to jail |
| `get_out_of_jail` | — | Player receives a Get Out of Jail Free card |
| `go_back` | `spaces` | Move back N spaces |
| `repairs` | `houseCost`, `hotelCost` | Charge per building owned |

You can add, remove, or reword any card. The deck is reshuffled automatically when exhausted.

---

## Architecture Overview

```
Client (Browser)
  │
  │  HTTP REST  (login, create game, list games)
  │  WebSocket  (Socket.io — real-time game events)
  │
  ▼
Express + Socket.io Server (Node.js)
  │
  ├── auth.js          ─ bcrypt password hashing, JWT sign/verify
  ├── config-loader.js ─ reads board.json, cards.json, settings.json
  ├── game-logic.js    ─ pure functions: all Monopoly rules, returns new state + events
  ├── game-manager.js  ─ manages in-memory game sessions, syncs to SQLite
  ├── socket-handler.js─ maps socket events → game-manager.applyAction()
  └── database.js      ─ better-sqlite3 wrapper (users, games, game_players tables)
```

### Data flow for a game action

```
1. Client emits socket event   →   e.g. "turn:rollDice"
2. socket-handler receives it  →   calls game-manager.applyAction('rollDice', ...)
3. game-manager calls          →   game-logic.rollDice(currentState, userId)
4. game-logic returns          →   { newState, events[] }  (pure, no side effects)
5. game-manager                →   stores newState in memory + SQLite
6. socket-handler broadcasts   →   io.to(gameId).emit('game:update', { state, events })
7. All clients receive update  →   update board, panels, log, etc.
```

### Game state schema (abbreviated)

```js
{
  id:         string,          // UUID
  name:       string,
  status:     'waiting' | 'playing' | 'paused' | 'finished',
  config:     GameConfig,      // embedded copy of config-loader output
  players:    Player[],
  properties: { [position]: { ownerId, houses, mortgaged } },
  turnState:  {
    currentPlayerIndex: number,
    phase: 'pre-roll' | 'post-roll' | 'buying' | 'auctioning' | 'card',
    dice:    [number, number],
    doubles: number,
  },
  auction:    Auction | null,
  trade:      Trade | null,
  chanceDeck: number[],        // shuffled index array
  chestDeck:  number[],
  freeParking: number,
  log:        LogEntry[],
}
```

---

## API Reference

All REST endpoints are under `/api`. Authenticated endpoints require an `Authorization: Bearer <token>` header.

### Auth

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| POST | `/api/auth/register` | — | `{ username, password }` | `{ token, user }` |
| POST | `/api/auth/login` | — | `{ username, password }` | `{ token, user }` |
| GET | `/api/auth/me` | ✓ | — | `{ id, username }` |

### Games

| Method | Path | Auth | Body | Response |
|--------|------|------|------|----------|
| GET | `/api/games` | ✓ | — | `{ games[] }` — open & in-progress games |
| GET | `/api/games/saved` | ✓ | — | `{ games[] }` — saved games for current user |
| POST | `/api/games` | ✓ | `{ name, configOverrides? }` | `{ gameId, state }` |
| GET | `/api/games/:id` | ✓ | — | `{ state }` |
| POST | `/api/games/:id/join` | ✓ | — | `{ state }` |
| POST | `/api/games/:id/start` | ✓ (host only) | — | `{ state }` |
| POST | `/api/games/:id/save` | ✓ (host only) | — | `{ success }` |
| GET | `/api/games/config/default` | ✓ | — | `{ config }` |
| POST | `/api/games/config/reload` | ✓ | — | `{ success, config }` — hot-reload config files |

---

## Socket.io Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join_game` | `gameId` | Join socket room for a game |
| `leave_game` | — | Leave current game room |
| `lobby:join` | `gameId` | Join a waiting-room lobby |
| `game:start` | — | Host starts the game |
| `turn:rollDice` | — | Roll dice |
| `turn:buyProperty` | — | Buy current property |
| `turn:declinePurchase` | — | Decline to buy (triggers auction) |
| `turn:auction:bid` | `{ amount }` | Place bid in auction |
| `turn:auction:pass` | — | Pass on auction |
| `turn:buildHouse` | `{ position }` | Build house/hotel on property |
| `turn:sellHouse` | `{ position }` | Sell house/hotel |
| `turn:mortgage` | `{ position }` | Mortgage a property |
| `turn:unmortgage` | `{ position }` | Unmortgage a property |
| `turn:payJailFine` | — | Pay $50 jail fine |
| `turn:useJailCard` | — | Use Get Out of Jail Free card |
| `turn:endTurn` | — | End current turn |
| `trade:offer` | `{ toUserId, offerMoney, offerProps, offerCards, requestMoney, requestProps, requestCards }` | Propose a trade |
| `trade:accept` | — | Accept pending trade |
| `trade:reject` | — | Reject pending trade |
| `trade:cancel` | — | Cancel outgoing trade |
| `game:bankruptcy` | — | Declare bankruptcy |
| `game:save` | — | Save (pause) the game |
| `chat:message` | `{ text }` | Send chat message |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `game:state` | `{ state }` | Full game state (on join or reconnect) |
| `game:update` | `{ state, events[] }` | State + events after every action |
| `game:error` | `{ message }` | Action rejected (to acting client only) |
| `game:saved` | `{ savedBy }` | Game was saved |
| `trade:incoming` | `{ from, payload }` | Trade offer received |
| `chat:message` | `{ username, text, timestamp }` | Chat message |
| `auth:error` | `{ message }` | Auth failure (socket will be closed) |

---

## Security Notes

- **JWT Secret:** Set the `JWT_SECRET` environment variable before running in production. The default is a hardcoded string that is intentionally insecure.
  ```bash
  JWT_SECRET=your-very-long-random-secret npm start
  ```
- **Local network only:** CORS is set to `*` and the server binds to all interfaces, which is appropriate for a LAN game. Do **not** expose this server to the public internet without adding proper authentication, rate limiting, and HTTPS.
- **Passwords** are hashed with bcrypt (12 salt rounds) before storage.
- **Server-side validation:** All game actions are validated on the server. Clients cannot cheat by sending invalid actions or manipulating state directly.

---

## Development

### Run with auto-restart (nodemon)

```bash
cd server
npm run dev
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port |
| `HOST` | `0.0.0.0` | Bind address |
| `JWT_SECRET` | *(insecure default)* | JWT signing secret |
| `JWT_EXPIRES` | `7d` | JWT token lifetime |

### Database location

`server/data/monopoly.db` — SQLite file, created automatically on first run.
The `server/data/` directory is in `.gitignore` so the database is never committed.

### Adding / modifying rules

1. Edit the relevant config file (`board.json`, `cards.json`, or `settings.json`).
2. Restart the server or call `POST /api/games/config/reload` while it's running.
3. Existing in-progress games are not affected (they embed a copy of the config at start time).

### Extending game-logic.js

All Monopoly rules are in `server/src/game-logic.js`. Each exported function:
- Takes a `GameState` as its first argument
- Returns `{ state, events, error? }` — **never mutates the input**
- Logs human-readable messages to `state.log`
- Returns `event` objects that the socket handler broadcasts to clients

This pure-function design makes it straightforward to add new rules or house rules.

---

## Known Limitations & Future Ideas

- **No spectator mode yet** — the setting exists in `settings.json` but is not wired up.
- **No per-player config editing UI** — config can be set at game creation but not via a GUI editor. Edit the JSON files directly.
- **No timer per turn** — disconnected players hold up the game. A future version could auto-skip disconnected players after a configurable timeout.
- **No undo** — actions are final once emitted.
- **Trading UI is basic** — a drag-and-drop trade builder would be nicer.
- **Mobile layout** — the board scales down but touch interactions are not optimized.
- **Future ideas:** AI players, custom board themes, house-rule presets (Speed Die, Free Parking jackpot from the box, etc.)
