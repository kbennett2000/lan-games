/**
 * ConnectFourRenderer
 *
 * Renders a Connect Four board inside the game screen's board-wrapper area.
 * Hides the Monopoly board while active and restores it on teardown.
 *
 * Public API (mirrors the BoardRenderer interface used by app.js / socket-client.js):
 *   buildBoard(config, onDropFn)   — create the grid; called once per game
 *   update(state)                  — repaint pieces from state
 *   updateActionPanel(state, myUserId)  — update sidebar title + enable/disable column btns
 *   teardown()                     — restore Monopoly board visibility
 */

const ConnectFourRenderer = (() => {

  let _onDrop = null; // (column: number) => void

  // ── buildBoard ──────────────────────────────────────────────────────────────

  function buildBoard(config, onDrop) {
    _onDrop = onDrop;

    const { boardWidth, boardHeight } = config.settings;

    // Switch board visibility
    const monoBoard = document.getElementById('board');
    const wrapper   = document.getElementById('connect-four-wrapper');
    if (monoBoard) monoBoard.style.display = 'none';
    if (!wrapper)  return;
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
      btn.disabled    = true; // enabled by updateActionPanel when it's my turn
      btn.addEventListener('click', () => { if (_onDrop) _onDrop(c); });
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
  }

  // ── updateActionPanel ───────────────────────────────────────────────────────

  function updateActionPanel(state, myUserId) {
    const cur      = state.players[state.turnState?.currentPlayerIndex];
    const isMyTurn = cur?.userId === myUserId;
    const playing  = state.status === 'playing';

    // Sidebar title
    const titleEl = document.getElementById('action-title');
    if (titleEl) {
      if (!playing) {
        titleEl.textContent = 'Game over';
      } else {
        titleEl.textContent = isMyTurn ? 'Your turn — pick a column' : `Waiting for ${cur?.username || ''}…`;
      }
    }

    // Clear Monopoly action buttons
    const buttonsEl = document.getElementById('action-buttons');
    if (buttonsEl) buttonsEl.innerHTML = '';
    const auctionEl = document.getElementById('auction-panel');
    if (auctionEl) auctionEl.style.display = 'none';

    // Enable/disable column drop buttons
    const colBtns = document.getElementById('cf-col-buttons');
    if (!colBtns) return;
    colBtns.querySelectorAll('.cf-col-btn').forEach((btn, c) => {
      const colFull = state.board[0]?.[c] !== null;
      btn.disabled  = !isMyTurn || colFull || !playing;
    });
  }

  // ── teardown ────────────────────────────────────────────────────────────────

  function teardown() {
    _onDrop = null;
    const monoBoard = document.getElementById('board');
    const wrapper   = document.getElementById('connect-four-wrapper');
    if (monoBoard) monoBoard.style.display = '';
    if (wrapper)   { wrapper.style.display = 'none'; wrapper.innerHTML = ''; }
  }

  // ── public API ──────────────────────────────────────────────────────────────

  return { buildBoard, update, updateActionPanel, teardown };

})();
