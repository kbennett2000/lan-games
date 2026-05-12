/**
 * board-renderer.js
 *
 * Builds and updates the visual Monopoly board using CSS Grid.
 *
 * Board layout (CSS grid row/col, 1-indexed):
 *
 *   Row 1  (top)    col 1..11  — positions 30..20  (left→right)
 *   Row 11 (bottom) col 1..11  — positions 10..0   (left→right)
 *   Col 1  (left)   row 2..10  — positions 31..39  (top→bottom)
 *   Col 11 (right)  row 2..10  — positions 11..19  (top→bottom)
 *   Center (rows 2-10, cols 2-10) — the board-center div
 *
 * Clicking a property square opens the property detail modal.
 */

const BoardRenderer = (() => {

  // Map: board position → { gridRow, gridCol, edge }
  // edge: 'top' | 'bottom' | 'left' | 'right' | 'corner'
  const SQUARE_GRID = (() => {
    const map = {};

    // Bottom row (row 11, col 11→1): positions 0→10
    for (let i = 0; i <= 10; i++) {
      map[i] = { gridRow: 11, gridCol: 11 - i, edge: i === 0 || i === 10 ? 'corner' : 'bottom' };
    }
    // Left column (col 1, row 10→2): positions 11→19
    for (let i = 11; i <= 19; i++) {
      map[i] = { gridRow: 10 - (i - 11), gridCol: 1, edge: 'left' };
    }
    // Top row (row 1, col 1→11): positions 20→30
    for (let i = 20; i <= 30; i++) {
      map[i] = { gridRow: 1, gridCol: i - 20 + 1, edge: i === 20 || i === 30 ? 'corner' : 'top' };
    }
    // Right column (col 11, row 2→10): positions 31→39
    for (let i = 31; i <= 39; i++) {
      map[i] = { gridRow: (i - 31) + 2, gridCol: 11, edge: 'right' };
    }

    return map;
  })();

  // Property group colors used for CSS classes
  const GROUP_CSS = {
    brown:    'color-brown',
    lightblue:'color-lightblue',
    pink:     'color-pink',
    orange:   'color-orange',
    red:      'color-red',
    yellow:   'color-yellow',
    green:    'color-green',
    darkblue: 'color-darkblue',
  };

  // Die face unicode characters
  const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

  let _onSquareClick = null; // callback(position)

  // ── build initial board ────────────────────────────────────────────────────

  /**
   * Generate all 40 square elements and insert them into #board.
   * The board-center div must already be in the DOM.
   * @param {object[]} boardConfig  — state.config.board
   */
  function buildBoard(boardConfig, onSquareClick) {
    _onSquareClick = onSquareClick;
    const board = document.getElementById('board');

    // Remove any existing squares (but keep .board-center)
    board.querySelectorAll('.square').forEach(el => el.remove());

    for (let pos = 0; pos < 40; pos++) {
      const sq    = boardConfig[pos];
      const grid  = SQUARE_GRID[pos];
      const el    = createSquareEl(sq, grid);
      el.style.gridRow    = grid.gridRow;
      el.style.gridColumn = grid.gridCol;
      board.appendChild(el);
    }
  }

  function createSquareEl(sq, grid) {
    const el = document.createElement('div');
    el.className   = `square edge-${grid.edge} type-${sq.type}`;
    el.dataset.pos = sq.position;

    // Color band for purchasable property squares
    if (sq.type === 'property' && sq.colorGroup) {
      const band = document.createElement('div');
      band.className = `color-band ${GROUP_CSS[sq.colorGroup] || ''}`;
      el.appendChild(band);
    }

    // Inner text wrapper
    const inner = document.createElement('div');
    inner.className = 'sq-inner';

    const name = document.createElement('div');
    name.className = 'sq-name';

    if (grid.edge === 'corner') {
      name.textContent = getCornerLabel(sq);
    } else {
      name.textContent = sq.name;
    }
    inner.appendChild(name);

    if (sq.price) {
      const price = document.createElement('div');
      price.className = 'sq-price';
      price.textContent = `$${sq.price}`;
      inner.appendChild(price);
    }

    el.appendChild(inner);

    // Tokens container (player pieces)
    const tokens = document.createElement('div');
    tokens.className = 'tokens-container';
    tokens.id = `tokens-${sq.position}`;
    el.appendChild(tokens);

    // Buildings container
    const buildings = document.createElement('div');
    buildings.className = 'buildings';
    buildings.id = `buildings-${sq.position}`;
    el.appendChild(buildings);

    // Ownership dot
    const ownerDot = document.createElement('div');
    ownerDot.className = 'ownership-dot';
    ownerDot.id = `owner-dot-${sq.position}`;
    ownerDot.style.display = 'none';
    el.appendChild(ownerDot);

    // Click handler for purchasable squares
    if (['property', 'railroad', 'utility'].includes(sq.type)) {
      el.classList.add('clickable');
      el.addEventListener('click', () => {
        if (_onSquareClick) _onSquareClick(sq.position);
      });
    }

    return el;
  }

  function getCornerLabel(sq) {
    switch (sq.type) {
      case 'go':           return 'GO →';
      case 'jail':         return '🚔 JAIL\nJust Visiting';
      case 'free_parking': return '🅿 FREE\nPARKING';
      case 'go_to_jail':   return '→ GO TO\nJAIL';
      default:             return sq.name;
    }
  }

  // ── update board from game state ───────────────────────────────────────────

  /**
   * Update all dynamic elements on the board to reflect the current state.
   * Called whenever the server pushes a game:update event.
   *
   * @param {object} state  — full GameState from server
   */
  function update(state) {
    if (!state) return;

    // Clear all token containers
    document.querySelectorAll('.tokens-container').forEach(el => { el.innerHTML = ''; });

    // Place player tokens
    for (const player of state.players) {
      if (player.isBankrupt) continue;
      const container = document.getElementById(`tokens-${player.position}`);
      if (!container) continue;

      const token = document.createElement('div');
      token.className   = 'player-token';
      token.title       = player.username;
      token.textContent = player.token;
      token.style.background = getPlayerColorHex(state, player);
      container.appendChild(token);
    }

    // Update property squares (ownership, buildings, mortgaged state)
    for (const [posStr, propState] of Object.entries(state.properties)) {
      const pos = Number(posStr);
      const sq  = document.querySelector(`.square[data-pos="${pos}"]`);
      if (!sq) continue;

      sq.classList.toggle('owned',     !!propState.ownerId);
      sq.classList.toggle('mortgaged', propState.mortgaged);

      // Ownership dot
      const ownerDot = document.getElementById(`owner-dot-${pos}`);
      if (ownerDot) {
        if (propState.ownerId) {
          const owner = state.players.find(p => p.userId === propState.ownerId);
          ownerDot.style.display    = 'block';
          ownerDot.style.background = getPlayerColorHex(state, owner);
          ownerDot.title            = owner ? `Owned by ${owner.username}` : '';
        } else {
          ownerDot.style.display = 'none';
        }
      }

      // Buildings
      const buildingContainer = document.getElementById(`buildings-${pos}`);
      if (buildingContainer) {
        buildingContainer.innerHTML = '';
        if (propState.houses > 0 && !propState.mortgaged) {
          if (propState.houses === 5) {
            // Hotel
            const hotel = document.createElement('div');
            hotel.className = 'hotel-dot';
            hotel.title = 'Hotel';
            buildingContainer.appendChild(hotel);
          } else {
            // Houses
            for (let h = 0; h < propState.houses; h++) {
              const house = document.createElement('div');
              house.className = 'house-dot';
              house.title = `${propState.houses} house(s)`;
              buildingContainer.appendChild(house);
            }
          }
        }
      }
    }

    // Update dice display
    const [d1, d2] = state.turnState?.dice || [0, 0];
    const die1El   = document.getElementById('die1');
    const die2El   = document.getElementById('die2');
    if (die1El) die1El.textContent = d1 ? DIE_FACES[d1] || d1 : '—';
    if (die2El) die2El.textContent = d2 ? DIE_FACES[d2] || d2 : '—';

    // Update free parking pot
    const potEl = document.getElementById('free-parking-pot');
    const amtEl = document.getElementById('free-parking-amount');
    if (potEl && amtEl) {
      const showPot = state.config?.settings?.freeParkingJackpot;
      potEl.style.display = showPot ? 'block' : 'none';
      if (showPot) amtEl.textContent = `$${state.freeParking || 0}`;
    }

    // Update auction center display
    const auctionCenter = document.getElementById('auction-center');
    if (auctionCenter) {
      if (state.auction) {
        auctionCenter.style.display = 'block';
        const sq = state.config.board[state.auction.position];
        document.getElementById('auction-property-name').textContent = sq?.name || '';
        document.getElementById('auction-high-bid').textContent = `$${state.auction.highBid}`;
        const highBidder = state.players.find(p => p.userId === state.auction.highBidder);
        document.getElementById('auction-high-bidder').textContent = highBidder?.username || '—';
      } else {
        auctionCenter.style.display = 'none';
      }
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function getPlayerColorHex(state, player) {
    if (!player) return '#888';
    const colorCfg = state.config?.settings?.playerColors?.find(c => c.id === player.color);
    return colorCfg?.hex || player.colorHex || '#888';
  }

  /**
   * Briefly animate a square to draw attention (e.g. when a player lands on it).
   */
  function flashSquare(position) {
    const sq = document.querySelector(`.square[data-pos="${position}"]`);
    if (!sq) return;
    sq.style.transition = 'none';
    sq.style.filter     = 'brightness(1.6)';
    setTimeout(() => {
      sq.style.transition = 'filter 0.6s';
      sq.style.filter     = '';
    }, 50);
  }

  return { buildBoard, update, flashSquare };

})();
