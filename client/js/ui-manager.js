/**
 * ui-manager.js
 *
 * Manages all UI updates that are NOT part of the board itself:
 *   - Player panels in the sidebar
 *   - Action buttons panel
 *   - Auction panel
 *   - Game log
 *   - Chat messages
 *   - Modals (property detail, trade, trade-incoming, game-over)
 *   - Screen transitions (auth / lobby / waiting / game)
 *   - Lobby game list
 *   - Waiting room player list
 */

// Pip slots active for each die face value (3×3 grid: tl tm tr / ml mm mr / bl bm br)
const DIE_PIPS = {
  1: ['mm'],
  2: ['tr', 'bl'],
  3: ['tr', 'mm', 'bl'],
  4: ['tl', 'tr', 'bl', 'br'],
  5: ['tl', 'tr', 'mm', 'bl', 'br'],
  6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br'],
};
const ALL_SLOTS = ['tl', 'tm', 'tr', 'ml', 'mm', 'mr', 'bl', 'bm', 'br'];

function setDiePips(prefix, value) {
  const active = new Set(DIE_PIPS[value] || []);
  for (const slot of ALL_SLOTS) {
    const el = document.getElementById(`${prefix}-${slot}`);
    if (el) el.classList.toggle('pip', active.has(slot));
  }
}

const UIManager = (() => {

  // ── screen management ──────────────────────────────────────────────────────

  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
  }

  // ── game log ────────────────────────────────────────────────────────────────

  const MAX_LOG_ENTRIES = 100;

  const LOG_ICONS = {
    dice:     '🎲',
    move:     '▸',
    money:    '💰',
    property: '🏠',
    jail:     '🚔',
    card:     '🃏',
    trade:    '🤝',
    auction:  '🔔',
    game:     '🏆',
    info:     '·',
    turn:     '',
  };

  function appendLog(message, type = 'info') {
    const log = document.getElementById('game-log');
    if (!log) return;

    const entry = document.createElement('div');
    entry.className = `log-entry type-${type}`;

    if (type === 'turn') {
      entry.innerHTML = `<span class="log-divider-text">${escHtml(message)}</span>`;
    } else {
      const icon = LOG_ICONS[type] ?? '·';
      entry.innerHTML = `<span class="log-icon">${icon}</span><span class="log-msg">${escHtml(message)}</span>`;
    }

    log.appendChild(entry);
    while (log.children.length > MAX_LOG_ENTRIES) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function appendLogsFromState(state) {
    if (!state?.log) return;
    const log = document.getElementById('game-log');
    if (!log) return;
    // Display only the last 50 log entries on each full state sync
    const entries = state.log.slice(-50);
    log.innerHTML   = '';
    for (const e of entries) appendLog(e.message, e.type);
  }

  // ── chat ────────────────────────────────────────────────────────────────────

  function appendChat(username, text) {
    const chat = document.getElementById('chat-messages');
    if (!chat) return;
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    msg.innerHTML = `<span class="chat-msg-name">${escHtml(username)}:</span> <span class="chat-msg-text">${escHtml(text)}</span>`;
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  }

  // ── player panels ──────────────────────────────────────────────────────────

  function updatePlayerPanels(state) {
    const panel = document.getElementById('players-panel');
    if (!panel || !state) return;

    // Build a card per player
    const currentPlayerIdx = state.turnState?.currentPlayerIndex ?? -1;

    panel.innerHTML = '';
    state.players.forEach((player, idx) => {
      const card = document.createElement('div');
      card.className = 'player-card';
      if (idx === currentPlayerIdx) card.classList.add('active-turn');
      if (player.isBankrupt)        card.classList.add('bankrupt');

      const colorHex = getPlayerColorHex(state, player);
      const ownedCount = Object.values(state.properties).filter(ps => ps.ownerId === player.userId).length;

      let badges = '';
      if (player.inJail)     badges += `<span class="player-jail-badge">JAIL</span>`;
      if (player.isBankrupt) badges += `<span class="player-jail-badge">OUT</span>`;
      if (!player.connected) badges += `<span class="player-jail-badge" style="background:#666">AFK</span>`;

      card.innerHTML = `
        <div class="player-card-header">
          <div class="player-color-dot" style="background:${colorHex}"></div>
          <span class="player-card-name">${escHtml(player.username)} ${player.token}</span>
          ${badges}
          <span class="player-card-money">$${player.money.toLocaleString()}</span>
        </div>
        <div class="player-card-props">
          ${ownedCount} propert${ownedCount === 1 ? 'y' : 'ies'}
          ${player.jailCards > 0 ? ` · ${player.jailCards} jail card(s)` : ''}
        </div>
      `;
      panel.appendChild(card);
    });
  }

  // ── turn indicator ─────────────────────────────────────────────────────────

  function updateTurnIndicator(state, myUserId) {
    const el = document.getElementById('game-turn-indicator');
    if (!el || !state?.turnState) return;

    const currentPlayer = state.players[state.turnState.currentPlayerIndex];
    if (!currentPlayer) return;

    const isMyTurn = currentPlayer.userId === myUserId;
    el.textContent = isMyTurn ? 'Your turn!' : `${currentPlayer.username}'s turn`;
    el.classList.toggle('my-turn', isMyTurn);

    // Dice display
    const [d1, d2]  = state.turnState.dice || [0, 0];
    const diceEl    = document.getElementById('dice-display');
    const doublesEl = document.getElementById('doubles-badge');
    if (!diceEl) return;
    if (d1 === 0 && d2 === 0) {
      diceEl.style.display = 'none';
    } else {
      setDiePips('d1', d1);
      setDiePips('d2', d2);
      doublesEl.style.display = (d1 === d2) ? '' : 'none';
      diceEl.style.display = 'flex';
    }
  }

  // ── action buttons ─────────────────────────────────────────────────────────

  /**
   * Rebuild the action panel based on current game state and whose turn it is.
   * @param {object} state
   * @param {string} myUserId
   * @param {object} handlers  — map of action name → callback function
   */
  function updateActionPanel(state, myUserId, handlers) {
    const titleEl   = document.getElementById('action-title');
    const buttonsEl = document.getElementById('action-buttons');
    const auctionEl = document.getElementById('auction-panel');
    if (!buttonsEl || !state) return;

    buttonsEl.innerHTML = '';
    auctionEl.style.display = 'none';

    if (!state.turnState) return;

    const phase         = state.turnState.phase;
    const currentPlayer = state.players[state.turnState.currentPlayerIndex];
    const myPlayer      = state.players.find(p => p.userId === myUserId);
    const isMyTurn      = currentPlayer?.userId === myUserId;

    if (titleEl) {
      titleEl.textContent = isMyTurn ? 'Your Actions' : `Waiting for ${currentPlayer?.username || ''}…`;
    }

    if (!myPlayer || myPlayer.isBankrupt) {
      addBtn(buttonsEl, '📜 View Properties', 'btn-outline', handlers.openTradeModal);
      return;
    }

    // ── Auction panel (all players can bid regardless of turn) ──────────────
    if (state.auction && !myPlayer.isBankrupt && !state.auction.passed.includes(myUserId)) {
      auctionEl.style.display = 'block';
      const sq = state.config.board[state.auction.position];
      document.getElementById('auction-prop-name').textContent    = sq?.name || '';
      document.getElementById('auction-current-bid').textContent  = `$${state.auction.highBid}`;
      const hb = state.players.find(p => p.userId === state.auction.highBidder);
      document.getElementById('auction-bidder-name').textContent  = hb?.username || '—';

      document.getElementById('place-bid-btn').onclick = () => {
        const amount = parseInt(document.getElementById('auction-bid-input').value, 10);
        if (isNaN(amount)) return;
        handlers.placeBid(amount);
      };
      document.getElementById('pass-auction-btn').onclick = handlers.passAuction;
    }

    if (!isMyTurn) {
      // Non-active players can still trade
      if (state.config.settings.tradeEnabled) {
        addBtn(buttonsEl, '🤝 Propose Trade', 'btn-outline', handlers.openTradeModal);
      }
      return;
    }

    // ── Active player buttons ────────────────────────────────────────────────

    if (phase === 'pre-roll') {
      if (myPlayer.inJail) {
        addBtn(buttonsEl, '🎲 Roll Dice (try for doubles)', 'btn-primary', handlers.rollDice);
        addBtn(buttonsEl, `💸 Pay $${state.config.settings.jailFine} Fine`, 'btn-outline',
          handlers.payJailFine, myPlayer.money < state.config.settings.jailFine);
        if (myPlayer.jailCards > 0) {
          addBtn(buttonsEl, '🃏 Use Get Out of Jail Card', 'btn-outline', handlers.useJailCard);
        }
      } else {
        addBtn(buttonsEl, '🎲 Roll Dice', 'btn-primary', handlers.rollDice);
      }
    }

    if (phase === 'buying') {
      const position = myPlayer.position;
      const sq       = state.config.board[position];
      addBtn(buttonsEl, `🏠 Buy ${sq?.name} ($${sq?.price})`, 'btn-primary',
        handlers.buyProperty, myPlayer.money < sq?.price);
      addBtn(buttonsEl, '❌ Decline', 'btn-outline', handlers.declinePurchase);
    }

    if (phase === 'post-roll') {
      addBtn(buttonsEl, '✅ End Turn', 'btn-primary', handlers.endTurn);
    }

    // Always-available actions during pre-roll and post-roll
    if (phase === 'pre-roll' || phase === 'post-roll') {
      addBtn(buttonsEl, '🏘 Manage Properties', 'btn-outline', handlers.openPropertyModal);
      if (state.config.settings.tradeEnabled) {
        addBtn(buttonsEl, '🤝 Propose Trade', 'btn-outline', handlers.openTradeModal);
      }
      addBtn(buttonsEl, '💔 Declare Bankruptcy', 'btn-outline btn-danger', handlers.declareBankruptcy);
    }
  }

  function addBtn(container, label, classes, onClick, disabled = false) {
    const btn = document.createElement('button');
    btn.className   = `btn ${classes}`;
    btn.textContent = label;
    btn.disabled    = disabled;
    if (onClick) btn.addEventListener('click', () => {
      // Disable immediately to prevent double-emit from a laggy double-click.
      // The button will be recreated on the next state update anyway.
      btn.disabled = true;
      onClick();
    });
    container.appendChild(btn);
  }

  // ── lobby game list ────────────────────────────────────────────────────────

  /**
   * @param {object[]}  games
   * @param {string}    containerId
   * @param {Function}  onJoinClick      — called with gameId when Join/Resume/Rejoin clicked
   * @param {object}   [opts]
   * @param {Function} [opts.onDeleteClick]  — called with gameId; enables delete buttons
   * @param {string}   [opts.currentUserId]  — only show delete for games the user created
   * @param {boolean}  [opts.allowRejoin]    — show Rejoin button for 'playing' games
   */
  function renderGameList(games, containerId, onJoinClick, opts = {}) {
    const { onDeleteClick, currentUserId, allowRejoin = false } = opts;
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!games || games.length === 0) {
      container.innerHTML = '<p class="empty-state">No games available.</p>';
      return;
    }

    container.innerHTML = '';
    for (const g of games) {
      const statusLabel = { waiting: 'Open', playing: 'In Progress', paused: 'Saved', finished: 'Finished' }[g.status] || g.status;
      const statusClass = { waiting: 'status-waiting', playing: 'status-playing', paused: 'status-paused' }[g.status] || '';

      const card = document.createElement('div');
      card.className = 'game-card';
      card.innerHTML = `
        <div class="game-card-info">
          <h4>${escHtml(g.name)}</h4>
          <p>Host: ${escHtml(g.host_username || g.hostUsername || '?')} · ${g.player_count || g.playerCount || 0} player(s)</p>
        </div>
        <span class="game-card-status ${statusClass}">${statusLabel}</span>
      `;

      const canJoin   = g.status === 'waiting' || g.status === 'paused';
      const canRejoin = allowRejoin && g.status === 'playing';

      if (canJoin || canRejoin) {
        const btn = document.createElement('button');
        btn.className   = 'btn btn-primary btn-sm';
        btn.textContent = canRejoin ? 'Rejoin' : (g.status === 'paused' ? 'Resume' : 'Join');
        btn.addEventListener('click', () => onJoinClick(g.id));
        card.appendChild(btn);
      }

      if (onDeleteClick && currentUserId && g.created_by === currentUserId && g.status !== 'playing') {
        const del = document.createElement('button');
        del.className   = 'btn btn-sm btn-outline btn-danger';
        del.textContent = '🗑 Delete';
        del.style.marginLeft = '6px';
        del.addEventListener('click', () => onDeleteClick(g.id, g.name));
        card.appendChild(del);
      }

      container.appendChild(card);
    }
  }

  // ── waiting room ───────────────────────────────────────────────────────────

  function renderWaitingPlayers(state, myUserId, hostUserId) {
    const list = document.getElementById('waiting-players-list');
    if (!list || !state) return;

    list.innerHTML = '';
    for (const player of state.players) {
      const li = document.createElement('li');
      const colorHex = getPlayerColorHex(state, player);
      li.innerHTML = `
        <div class="player-token-badge" style="background:${colorHex}">${player.token}</div>
        <span>${escHtml(player.username)}</span>
        ${player.userId === hostUserId ? '<small style="color:var(--text-muted)">(host)</small>' : ''}
      `;
      list.appendChild(li);
    }

    // Show/hide start button
    const startBtn  = document.getElementById('start-game-btn');
    const hintEl    = document.getElementById('waiting-hint');
    const isHost    = myUserId === hostUserId;
    const minReady  = state.config?.settings?.minPlayersToStart ?? 2;

    if (startBtn) {
      startBtn.style.display = isHost ? 'inline-flex' : 'none';
      startBtn.disabled = state.players.length < minReady;
    }
    if (hintEl) {
      if (isHost) {
        hintEl.textContent = state.players.length < minReady
          ? `Need at least ${minReady} players to start.`
          : 'Ready to start!';
      } else {
        hintEl.textContent = 'Waiting for the host to start the game…';
      }
    }
  }

  // ── property detail modal ──────────────────────────────────────────────────

  function showPropertyModal(position, state, myUserId, handlers) {
    if (!state) return;
    const sq        = state.config.board[position];
    const propState = state.properties[position];
    if (!sq || !propState) return;

    const modal     = document.getElementById('property-modal');
    const titleEl   = document.getElementById('prop-modal-title');
    const bodyEl    = document.getElementById('prop-modal-body');
    if (!modal || !titleEl || !bodyEl) return;

    titleEl.textContent = sq.name;
    const owner     = state.players.find(p => p.userId === propState.ownerId);
    const isMyProp  = propState.ownerId === myUserId;
    const myPlayer  = state.players.find(p => p.userId === myUserId);
    const phase     = state.turnState?.phase;
    const canManage = isMyProp && myPlayer && !myPlayer.isBankrupt && (phase === 'pre-roll' || phase === 'post-roll');

    // Build rent table
    let rentRows = '';
    if (sq.type === 'property') {
      rentRows = `
        <div class="prop-detail-row"><span>Base rent</span><span>$${sq.rent.base}</span></div>
        <div class="prop-detail-row"><span>Rent (monopoly)</span><span>$${sq.rent.monopoly}</span></div>
        <div class="prop-detail-row"><span>1 house</span><span>$${sq.rent.oneHouse}</span></div>
        <div class="prop-detail-row"><span>2 houses</span><span>$${sq.rent.twoHouses}</span></div>
        <div class="prop-detail-row"><span>3 houses</span><span>$${sq.rent.threeHouses}</span></div>
        <div class="prop-detail-row"><span>4 houses</span><span>$${sq.rent.fourHouses}</span></div>
        <div class="prop-detail-row"><span>Hotel</span><span>$${sq.rent.hotel}</span></div>
        <div class="prop-detail-row"><span>House cost</span><span>$${sq.houseCost}</span></div>
      `;
    } else if (sq.type === 'railroad') {
      rentRows = `
        <div class="prop-detail-row"><span>1 railroad owned</span><span>$${sq.rent.owned1}</span></div>
        <div class="prop-detail-row"><span>2 railroads owned</span><span>$${sq.rent.owned2}</span></div>
        <div class="prop-detail-row"><span>3 railroads owned</span><span>$${sq.rent.owned3}</span></div>
        <div class="prop-detail-row"><span>4 railroads owned</span><span>$${sq.rent.owned4}</span></div>
      `;
    } else if (sq.type === 'utility') {
      rentRows = `
        <div class="prop-detail-row"><span>1 utility owned</span><span>Dice × ${sq.rent.multiplier1}</span></div>
        <div class="prop-detail-row"><span>2 utilities owned</span><span>Dice × ${sq.rent.multiplier2}</span></div>
      `;
    }

    const colorHex = {
      brown:'#8B4513', lightblue:'#87CEEB', pink:'#FF69B4', orange:'#FF8C00',
      red:'#DC143C', yellow:'#FFD700', green:'#228B22', darkblue:'#00008B',
    }[sq.colorGroup] || '#ccc';

    bodyEl.innerHTML = `
      <div class="prop-detail-card">
        ${sq.colorGroup ? `<div class="prop-color-stripe" style="background:${colorHex}"></div>` : ''}
        <div class="prop-detail-row"><span>Owner</span><span>${owner ? escHtml(owner.username) : 'Bank'}</span></div>
        <div class="prop-detail-row"><span>Status</span><span>${propState.mortgaged ? '🔒 Mortgaged' : propState.houses === 5 ? '🏨 Hotel' : propState.houses > 0 ? `🏠×${propState.houses}` : 'Unimproved'}</span></div>
        <div class="prop-detail-row"><span>Price</span><span>$${sq.price}</span></div>
        <div class="prop-detail-row"><span>Mortgage value</span><span>$${sq.mortgage}</span></div>
        <div class="prop-detail-row"><span>Unmortgage cost</span><span>$${sq.unmortgageCost}</span></div>
        ${rentRows}
      </div>
      <div class="prop-actions" id="prop-modal-actions"></div>
    `;

    // Buttons for owner
    if (canManage) {
      const actionsEl = document.getElementById('prop-modal-actions');
      if (!propState.mortgaged && propState.houses === 0) {
        addBtn(actionsEl, '🔒 Mortgage ($' + sq.mortgage + ')', 'btn-outline btn-full', () => {
          if (!confirm(`Mortgage ${sq.name} for $${sq.mortgage}?\nYou won't collect rent while it's mortgaged.`)) return;
          handlers.mortgageProperty(position);
          closePropertyModal();
        });
      }
      if (propState.mortgaged) {
        addBtn(actionsEl, '🔓 Unmortgage ($' + sq.unmortgageCost + ')', 'btn-outline btn-full', () => {
          if (!confirm(`Unmortgage ${sq.name} for $${sq.unmortgageCost}?`)) return;
          handlers.unmortgageProperty(position);
          closePropertyModal();
        }, myPlayer.money < sq.unmortgageCost);
      }
      if (sq.type === 'property' && !propState.mortgaged && propState.houses < 5) {
        const cost  = propState.houses === 4 ? sq.hotelCost : sq.houseCost;
        const btype = propState.houses === 4 ? 'hotel' : 'house';
        addBtn(actionsEl, `🏠 Build ${propState.houses === 4 ? 'Hotel' : 'House'} ($${cost})`, 'btn-primary btn-full', () => {
          if (!confirm(`Build a ${btype} on ${sq.name} for $${cost}?`)) return;
          handlers.buildHouse(position);
          closePropertyModal();
        }, myPlayer.money < cost);
      }
      if (sq.type === 'property' && propState.houses > 0) {
        const sellPrice = propState.houses === 5 ? Math.floor(sq.hotelCost / 2) : Math.floor(sq.houseCost / 2);
        const btype     = propState.houses === 5 ? 'Hotel' : 'House';
        addBtn(actionsEl, `💰 Sell ${btype} ($${sellPrice})`, 'btn-outline btn-full', () => {
          if (!confirm(`Sell a ${btype.toLowerCase()} on ${sq.name} for $${sellPrice}? (half price)`)) return;
          handlers.sellHouse(position);
          closePropertyModal();
        });
      }
    }

    modal.style.display = 'flex';
  }

  function closePropertyModal() {
    const modal = document.getElementById('property-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── my properties modal ────────────────────────────────────────────────────

  const PROP_COLOR_HEX = {
    brown:'#8B4513', lightblue:'#87CEEB', pink:'#FF69B4', orange:'#FF8C00',
    red:'#DC143C', yellow:'#FFD700', green:'#228B22', darkblue:'#00008B',
  };

  function showMyPropertiesModal(positions, state, myUserId, handlers) {
    const modal = document.getElementById('my-props-modal');
    const body  = document.getElementById('my-props-body');
    if (!modal || !body) return;

    const myPlayer = state.players.find(p => p.userId === myUserId);
    const phase    = state.turnState?.phase;
    const canManage = myPlayer && !myPlayer.isBankrupt && (phase === 'pre-roll' || phase === 'post-roll');

    body.innerHTML = '';
    for (const pos of positions) {
      const sq = state.config.board[pos];
      const ps = state.properties[pos];
      if (!sq || !ps) continue;

      const colorHex  = PROP_COLOR_HEX[sq.colorGroup] || '#999';
      const statusStr = ps.mortgaged ? '🔒 Mortgaged'
        : ps.houses === 5 ? '🏨 Hotel'
        : ps.houses > 0  ? `🏠 ×${ps.houses}`
        : 'Unimproved';

      const row = document.createElement('div');
      row.className = 'my-prop-row';
      row.innerHTML = `
        <div class="my-prop-color" style="background:${colorHex}"></div>
        <div class="my-prop-info">
          <span class="my-prop-name">${escHtml(sq.name)}</span>
          <span class="my-prop-status">${statusStr}</span>
        </div>
        <div class="my-prop-btns" id="mpb-${pos}"></div>
      `;
      body.appendChild(row);

      if (canManage) {
        const btns = row.querySelector(`#mpb-${pos}`);

        if (!ps.mortgaged && ps.houses === 0) {
          addBtn(btns, `🔒 $${sq.mortgage}`, 'btn-outline btn-sm', () => {
            if (!confirm(`Mortgage ${sq.name} for $${sq.mortgage}?\nYou won't collect rent while it's mortgaged.`)) return;
            handlers.mortgageProperty(pos);
            closeMyPropertiesModal();
          });
        }
        if (ps.mortgaged) {
          addBtn(btns, `🔓 $${sq.unmortgageCost}`, 'btn-outline btn-sm', () => {
            if (!confirm(`Unmortgage ${sq.name} for $${sq.unmortgageCost}?`)) return;
            handlers.unmortgageProperty(pos);
            closeMyPropertiesModal();
          }, myPlayer.money < sq.unmortgageCost);
        }
        if (sq.type === 'property' && !ps.mortgaged && ps.houses < 5) {
          const cost  = ps.houses === 4 ? sq.hotelCost : sq.houseCost;
          const btype = ps.houses === 4 ? 'hotel' : 'house';
          addBtn(btns, `🏠 $${cost}`, 'btn-primary btn-sm', () => {
            if (!confirm(`Build a ${btype} on ${sq.name} for $${cost}?`)) return;
            handlers.buildHouse(pos);
            closeMyPropertiesModal();
          }, myPlayer.money < cost);
        }
        if (sq.type === 'property' && ps.houses > 0) {
          const sell = ps.houses === 5 ? Math.floor(sq.hotelCost / 2) : Math.floor(sq.houseCost / 2);
          const btype = ps.houses === 5 ? 'hotel' : 'house';
          addBtn(btns, `💰 $${sell}`, 'btn-outline btn-sm', () => {
            if (!confirm(`Sell a ${btype} on ${sq.name} for $${sell}? (half price)`)) return;
            handlers.sellHouse(pos);
            closeMyPropertiesModal();
          });
        }
      }
    }

    modal.style.display = 'flex';
  }

  function closeMyPropertiesModal() {
    const modal = document.getElementById('my-props-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── trade modal ────────────────────────────────────────────────────────────

  function showTradeModal(state, myUserId) {
    const modal = document.getElementById('trade-modal');
    if (!modal || !state) return;

    // Populate target player dropdown
    const select = document.getElementById('trade-target-player');
    select.innerHTML = '<option value="">— Select player —</option>';
    for (const p of state.players) {
      if (p.userId === myUserId || p.isBankrupt) continue;
      const opt = document.createElement('option');
      opt.value       = p.userId;
      opt.textContent = p.username;
      select.appendChild(opt);
    }

    // Populate offer properties (properties I own)
    const offerProps = document.getElementById('trade-offer-props');
    offerProps.innerHTML = '';
    for (const [posStr, ps] of Object.entries(state.properties)) {
      if (ps.ownerId !== myUserId) continue;
      const sq   = state.config.board[Number(posStr)];
      const item = buildTradePropItem(sq, ps, posStr);
      offerProps.appendChild(item);
    }
    if (!offerProps.children.length) {
      offerProps.innerHTML = '<p style="color:var(--text-muted);font-size:12px">You own no properties.</p>';
    }

    // Request properties populated dynamically when target changes
    const requestProps = document.getElementById('trade-request-props');
    select.addEventListener('change', () => {
      requestProps.innerHTML = '';
      const targetId = select.value;
      if (!targetId) return;
      for (const [posStr, ps] of Object.entries(state.properties)) {
        if (ps.ownerId !== targetId) continue;
        const sq   = state.config.board[Number(posStr)];
        const item = buildTradePropItem(sq, ps, posStr);
        requestProps.appendChild(item);
      }
      if (!requestProps.children.length) {
        requestProps.innerHTML = '<p style="color:var(--text-muted);font-size:12px">They own no properties.</p>';
      }
    });

    // Reset fields
    document.getElementById('trade-offer-money').value    = 0;
    document.getElementById('trade-offer-cards').value    = 0;
    document.getElementById('trade-request-money').value  = 0;
    document.getElementById('trade-request-cards').value  = 0;
    document.getElementById('trade-error').textContent    = '';
    requestProps.innerHTML = '';

    modal.style.display = 'flex';
  }

  function buildTradePropItem(sq, ps, posStr) {
    const colorHex = {
      brown:'#8B4513', lightblue:'#87CEEB', pink:'#FF69B4', orange:'#FF8C00',
      red:'#DC143C', yellow:'#FFD700', green:'#228B22', darkblue:'#00008B',
    }[sq.colorGroup] || '#999';

    const div = document.createElement('div');
    div.className = 'trade-prop-item';
    div.innerHTML = `
      <input type="checkbox" value="${posStr}" ${ps.houses > 0 ? 'disabled' : ''}>
      <div class="trade-prop-color" style="background:${colorHex}"></div>
      <span>${escHtml(sq.name)}${ps.mortgaged ? ' (mortgaged)' : ''}${ps.houses > 0 ? ' (has buildings)' : ''}</span>
    `;
    return div;
  }

  function getCheckedTradeProps(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('input[type=checkbox]:checked')).map(cb => Number(cb.value));
  }

  function closeTrade() {
    const modal = document.getElementById('trade-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── incoming trade modal ───────────────────────────────────────────────────

  function showIncomingTrade(state, myUserId) {
    const modal = document.getElementById('trade-incoming-modal');
    const body  = document.getElementById('trade-incoming-body');
    if (!modal || !body || !state?.trade) return;

    const trade = state.trade;
    const from  = state.players.find(p => p.userId === trade.fromUserId);

    const propNames = (props) => props.map(pos => state.config.board[pos]?.name || pos).join(', ') || 'nothing';

    body.innerHTML = `
      <p><strong>${escHtml(from?.username || '?')}</strong> offers you:</p>
      <ul style="margin:8px 0 16px 16px;font-size:13px">
        <li>Money: $${trade.offerMoney}</li>
        <li>Properties: ${escHtml(propNames(trade.offerProps))}</li>
        <li>Jail cards: ${trade.offerCards}</li>
      </ul>
      <p>In exchange for:</p>
      <ul style="margin:8px 0 16px 16px;font-size:13px">
        <li>Money: $${trade.requestMoney}</li>
        <li>Properties: ${escHtml(propNames(trade.requestProps))}</li>
        <li>Jail cards: ${trade.requestCards}</li>
      </ul>
    `;

    modal.style.display = 'flex';
  }

  function closeIncomingTrade() {
    const modal = document.getElementById('trade-incoming-modal');
    if (modal) modal.style.display = 'none';
  }

  // ── game over modal ────────────────────────────────────────────────────────

  function showGameOver(winnerName) {
    const modal   = document.getElementById('game-over-modal');
    const message = document.getElementById('game-over-message');
    if (!modal || !message) return;
    message.textContent = winnerName ? `🎉 ${winnerName} wins!` : 'Game over!';
    modal.style.display = 'flex';
  }

  // ── utility ────────────────────────────────────────────────────────────────

  function getPlayerColorHex(state, player) {
    if (!player) return '#888';
    const cfg = state.config?.settings?.playerColors?.find(c => c.id === player.color);
    return cfg?.hex || player.colorHex || '#888';
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── showError helper ───────────────────────────────────────────────────────

  function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = message;
  }

  function clearError(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = '';
  }

  // ── exports ─────────────────────────────────────────────────────────────────

  return {
    showScreen,
    appendLog,
    appendLogsFromState,
    appendChat,
    updatePlayerPanels,
    updateTurnIndicator,
    updateActionPanel,
    renderGameList,
    renderWaitingPlayers,
    showPropertyModal,
    closePropertyModal,
    showMyPropertiesModal,
    closeMyPropertiesModal,
    showTradeModal,
    getCheckedTradeProps,
    closeTrade,
    showIncomingTrade,
    closeIncomingTrade,
    showGameOver,
    showError,
    clearError,
    escHtml,
  };

})();
