/**
 * Connect Four renderer — GameRenderer interface implementation.
 *
 * Self-registers with GameRendererRegistry at module load time.
 * The framework (app.js, socket-client.js) interacts with this module
 * exclusively through the registry; no direct references to this global.
 *
 * Implements: init / update / onEvent / destroy
 */

const ConnectFourRenderer = (() => {

  let _myUserId = null;
  let _emit     = null;

  // ── init ────────────────────────────────────────────────────────────────────

  function init(container, state, myUserId, emitAction) {
    _myUserId = myUserId;
    _emit     = emitAction;

    const { boardWidth, boardHeight } = state.config.settings;

    // Switch board visibility: hide Monopoly board, show CF wrapper.
    const monoBoard = document.getElementById('board');
    if (monoBoard) monoBoard.style.display = 'none';

    const wrapper = document.getElementById('connect-four-wrapper');
    if (!wrapper) return;
    wrapper.style.display = 'flex';
    wrapper.innerHTML = '';

    // Column drop buttons (▼ one per column, sits above the grid)
    const colBtns = document.createElement('div');
    colBtns.id        = 'cf-col-buttons';
    colBtns.className = 'cf-col-buttons';
    colBtns.style.gridTemplateColumns = `repeat(${boardWidth}, 1fr)`;

    for (let c = 0; c < boardWidth; c++) {
      const btn = document.createElement('button');
      btn.className   = 'cf-col-btn';
      btn.textContent = '▼';
      btn.dataset.col = String(c);
      btn.disabled    = true; // enabled by update() when it's my turn
      btn.addEventListener('click', () => { if (_emit) _emit('dropPiece', { column: c }); });
      colBtns.appendChild(btn);
    }
    wrapper.appendChild(colBtns);

    // The grid
    const grid = document.createElement('div');
    grid.id        = 'cf-grid';
    grid.className = 'cf-grid';
    grid.style.gridTemplateColumns = `repeat(${boardWidth}, 1fr)`;

    for (let r = 0; r < boardHeight; r++) {
      for (let c = 0; c < boardWidth; c++) {
        const cell = document.createElement('div');
        cell.className = 'cf-cell';
        cell.id        = `cf-cell-${r}-${c}`;
        grid.appendChild(cell);
      }
    }
    wrapper.appendChild(grid);
  }

  // ── update ──────────────────────────────────────────────────────────────────

  function update(state) {
    if (!state?.board) return;
    const { boardHeight, boardWidth } = state.config.settings;

    // Paint board cells
    for (let r = 0; r < boardHeight; r++) {
      for (let c = 0; c < boardWidth; c++) {
        const cell = document.getElementById(`cf-cell-${r}-${c}`);
        if (!cell) continue;
        const userId = state.board[r][c];
        if (userId) {
          const player = state.players.find(p => p.userId === userId);
          cell.style.background = player?.colorHex || '#888';
          cell.classList.add('filled');
        } else {
          cell.style.background = '';
          cell.classList.remove('filled');
        }
      }
    }

    // Sync action panel
    const cur      = state.players[state.turnState?.currentPlayerIndex];
    const isMyTurn = cur?.userId === _myUserId;
    const playing  = state.status === 'playing';

    const titleEl = document.getElementById('action-title');
    if (titleEl) {
      titleEl.textContent = !playing
        ? 'Game over'
        : isMyTurn ? 'Your turn — pick a column' : `Waiting for ${cur?.username || ''}…`;
    }

    // Clear Monopoly action buttons and auction panel
    const buttonsEl = document.getElementById('action-buttons');
    if (buttonsEl) buttonsEl.innerHTML = '';
    const auctionEl = document.getElementById('auction-panel');
    if (auctionEl) auctionEl.style.display = 'none';

    // Enable/disable column drop buttons
    const colBtns = document.getElementById('cf-col-buttons');
    if (colBtns) {
      colBtns.querySelectorAll('.cf-col-btn').forEach((btn, c) => {
        btn.disabled = !isMyTurn || !playing || state.board[0]?.[c] !== null;
      });
    }
  }

  // ── onEvent ─────────────────────────────────────────────────────────────────

  function onEvent(event, state) {
    switch (event.type) {
      case 'ACTION_REJECTED': {
        UIManager.appendLog(`⚠ ${event.data.message}`, 'info');
        const actionsEl = document.getElementById('action-buttons');
        if (actionsEl) {
          actionsEl.style.outline = '2px solid #e53935';
          setTimeout(() => { actionsEl.style.outline = ''; }, 1000);
        }
        break;
      }
      case 'GAME_OVER':
        UIManager.appendLog(
          event.data.winner ? `🏆 ${event.data.winner} wins!` : "🤝 It's a draw!", 'game'
        );
        SoundManager.playGameOver();
        break;
      // PIECE_DROPPED — no sound asset yet; silently accepted
      // All other event types are silently ignored per interface contract.
    }
  }

  // ── destroy ─────────────────────────────────────────────────────────────────

  function destroy() {
    const monoBoard = document.getElementById('board');
    const wrapper   = document.getElementById('connect-four-wrapper');
    if (monoBoard) monoBoard.style.display = '';
    if (wrapper)   { wrapper.style.display = 'none'; wrapper.innerHTML = ''; }
    _myUserId = null;
    _emit     = null;
  }

  // ── public API ───────────────────────────────────────────────────────────────

  return { init, update, onEvent, destroy };

})();

// Self-register with the framework registry.
GameRendererRegistry.register('connect-four', ConnectFourRenderer);
