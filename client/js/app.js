/**
 * app.js
 *
 * Application entry point.  Wires together all the modules and DOM event
 * listeners.  Runs after the page loads.
 *
 * Module load order (see index.html):
 *   api.js → game-state.js → board-renderer.js → ui-manager.js →
 *   socket-client.js → app.js
 */

(async function init() {

  // ── attempt silent re-auth from stored token ──────────────────────────────

  const token = API.getToken();
  if (token) {
    try {
      const user = await API.getMe();
      GameState.setUser(user);
      showLobby();
      SocketClient.connect();
    } catch {
      API.clearToken();
      UIManager.showScreen('auth-screen');
    }
  } else {
    UIManager.showScreen('auth-screen');
  }

  // Refresh the lobby game list whenever the server broadcasts a change
  // (new game created, player joined, game started, game deleted).
  SocketClient.onLobbyUpdate(() => {
    if (document.getElementById('lobby-screen')?.classList.contains('active')) {
      refreshGameList();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  AUTH SCREEN
  // ═══════════════════════════════════════════════════════════════════════════

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${btn.dataset.tab}-form`).classList.add('active');
    });
  });

  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    UIManager.clearError('login-error');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      const user = await API.login(username, password);
      GameState.setUser(user);
      // Go to lobby immediately; connect socket in the background so the
      // user never stares at the auth screen waiting for a WebSocket handshake.
      showLobby();
      SocketClient.connect();
    } catch (err) {
      UIManager.showError('login-error', err.message);
    }
  });

  // Register form
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    UIManager.clearError('register-error');
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    try {
      const user = await API.register(username, password);
      GameState.setUser(user);
      showLobby();
      SocketClient.connect();
    } catch (err) {
      UIManager.showError('register-error', err.message);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  LOBBY SCREEN
  // ═══════════════════════════════════════════════════════════════════════════

  async function showLobby() {
    const user = GameState.getUser();
    const el   = document.getElementById('header-username');
    if (el && user) el.textContent = `👤 ${user.username}`;
    UIManager.showScreen('lobby-screen');
    await Promise.all([refreshGameList(), refreshGameTypes()]);
  }

  async function refreshGameTypes() {
    try {
      const { types } = await API.getGameTypes();
      const select = document.getElementById('game-type');
      if (!select || !types) return;
      select.innerHTML = '';
      for (const t of types) {
        const opt = document.createElement('option');
        opt.value       = t.key;
        opt.textContent = t.name || t.key;
        select.appendChild(opt);
      }
      // Trigger visibility update for whichever type is now selected
      updateMonopolyConfigVisibility(select.value);
    } catch {
      // If the endpoint fails, the default <option> from HTML stays
    }
  }

  function updateMonopolyConfigVisibility(gameType) {
    const section = document.getElementById('monopoly-config-section');
    if (section) section.style.display = gameType === 'monopoly' ? '' : 'none';
  }

  document.getElementById('game-type').addEventListener('change', function () {
    updateMonopolyConfigVisibility(this.value);
  });

  async function refreshGameList() {
    const myUserId = GameState.getUser()?.id;
    const deleteOpts = {
      onDeleteClick: handleDeleteGame,
      currentUserId: myUserId,
    };

    // My in-progress games — show at the top with a Rejoin button
    try {
      const { games: mine } = await API.listMyActiveGames();
      const section = document.getElementById('my-games-section');
      if (mine && mine.length > 0) {
        if (section) section.style.display = 'block';
        UIManager.renderGameList(mine, 'my-games-list', handleRejoinGame, { allowRejoin: true });
      } else {
        if (section) section.style.display = 'none';
      }
    } catch {}

    try {
      const { games } = await API.listGames();
      UIManager.renderGameList(games, 'games-list', handleJoinGame, deleteOpts);
    } catch (err) {
      console.error('listGames error:', err);
    }
    try {
      const { games: saved } = await API.listSavedGames();
      UIManager.renderGameList(saved, 'saved-games-list', handleRejoinGame, deleteOpts);
    } catch {}
  }

  document.getElementById('refresh-games-btn').addEventListener('click', refreshGameList);

  document.getElementById('logout-btn').addEventListener('click', () => {
    API.logout();
    GameState.clear();
    UIManager.showScreen('auth-screen');
  });

  // Create game form
  document.getElementById('toggle-config').addEventListener('click', function () {
    const panel = document.getElementById('config-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    this.textContent    = panel.style.display === 'none' ? '▶ Customize Rules' : '▼ Customize Rules';
  });

  document.getElementById('create-game-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    UIManager.clearError('create-error');

    const name     = document.getElementById('game-name').value.trim();
    const gameType = document.getElementById('game-type').value || 'monopoly';
    if (!name) return UIManager.showError('create-error', 'Please enter a game name');

    // Monopoly-specific rule overrides — only collected when the game type supports them
    const configOverrides = gameType === 'monopoly' ? {
      settings: {
        startingMoney:      Number(document.getElementById('cfg-starting-money').value),
        goSalary:           Number(document.getElementById('cfg-go-salary').value),
        jailFine:           Number(document.getElementById('cfg-jail-fine').value),
        freeParkingJackpot: document.getElementById('cfg-free-parking').checked,
        auctionEnabled:     document.getElementById('cfg-auction').checked,
      },
    } : {};

    try {
      const { gameId, state } = await API.createGame(name, gameType, configOverrides);
      // state.createdBy is set by the server — no need to track it separately
      await joinWaitingRoom(gameId, state);
    } catch (err) {
      UIManager.showError('create-error', err.message);
    }
  });

  // Join an open game from the list (also used by host after page refresh)
  async function handleJoinGame(gameId) {
    try {
      // REST call adds us to the DB; the socket join_game event will add us
      // to the in-memory player list and broadcast the updated state to the room.
      const { state } = await API.joinGame(gameId);
      await joinWaitingRoom(gameId, state);
    } catch (err) {
      alert(err.message);
    }
  }

  // Rejoin a game already in progress (page refresh / browser close & reopen)
  async function handleRejoinGame(gameId) {
    try {
      const { state } = await API.getGame(gameId);
      // joinWaitingRoom detects status === 'playing' and goes straight to game screen
      await joinWaitingRoom(gameId, state);
    } catch (err) {
      alert(err.message);
    }
  }

  // Delete a game (host only, waiting or paused)
  async function handleDeleteGame(gameId, gameName) {
    if (!confirm(`Delete "${gameName}"? This cannot be undone.`)) return;
    try {
      await API.deleteGame(gameId);
      await refreshGameList();
    } catch (err) {
      alert(err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  WAITING ROOM
  // ═══════════════════════════════════════════════════════════════════════════

  async function joinWaitingRoom(gameId, state) {
    GameState.setGameId(gameId);

    if (state.status === 'playing' || state.status === 'paused') {
      // Go straight to the game screen; enterGameScreen sets state internally.
      // Do NOT call GameState.setState here first — that would fire onChange which
      // also calls enterGameScreen (before showScreen runs), causing deep recursion.
      enterGameScreen(state);
    } else {
      document.getElementById('waiting-game-name').textContent = state.name;
      document.getElementById('waiting-username').textContent  = GameState.getUser()?.username || '';
      GameState.setState(state);
      UIManager.showScreen('waiting-screen');
      UIManager.renderWaitingPlayers(state, GameState.getUser()?.id, state.createdBy);
    }

    // Join the socket room — the server will idempotently add us to the lobby
    // player list and broadcast the fresh state to everyone already in the room.
    SocketClient.joinGameRoom(gameId, (err) => {
      if (err) console.error('joinGameRoom error:', err);
    });
  }

  document.getElementById('leave-lobby-btn').addEventListener('click', () => {
    SocketClient.leaveRoom();
    GameState.clear();
    showLobby();
  });

  document.getElementById('start-game-btn').addEventListener('click', () => {
    SocketClient.startGame();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  GAME SCREEN
  // ═══════════════════════════════════════════════════════════════════════════

  function enterGameScreen(state) {
    // Show the screen BEFORE calling GameState.setState so that the onChange
    // listener sees the game screen as active and does not call enterGameScreen
    // recursively (which would cause a stack overflow swallowed by try/catch,
    // making the browser unresponsive for up to a minute).
    UIManager.showScreen('game-screen');
    document.getElementById('game-title').textContent = state.name;

    // Reset board area so switching game types is clean
    const monoBoard = document.getElementById('board');
    const cfWrapper = document.getElementById('connect-four-wrapper');
    if (monoBoard) monoBoard.style.display = '';
    if (cfWrapper) { cfWrapper.style.display = 'none'; cfWrapper.innerHTML = ''; }

    GameState.setState(state);

    const myUserId = GameState.getUser()?.id;

    if (state.gameType === 'connect-four') {
      ConnectFourRenderer.buildBoard(state.config, (col) => SocketClient.emitAction('dropPiece', { column: col }));
      ConnectFourRenderer.update(state);
      UIManager.updatePlayerPanels(state);
      UIManager.updateTurnIndicator(state, myUserId);
      ConnectFourRenderer.updateActionPanel(state, myUserId);
    } else {
      BoardRenderer.buildBoard(state.config.board, (pos) => {
        UIManager.showPropertyModal(pos, GameState.getState(), myUserId, SocketClient.getPropertyHandlers());
      });
      BoardRenderer.update(state);
      UIManager.updatePlayerPanels(state);
      UIManager.updateTurnIndicator(state, myUserId);
      UIManager.updateActionPanel(state, myUserId, SocketClient.getActionHandlers());
    }

    UIManager.appendLogsFromState(state);
  }

  // Watch for game status changes driven by socket events
  GameState.onChange((state) => {
    if (!state) return;
    if (state.status === 'playing') {
      const isOnGameScreen = document.getElementById('game-screen').classList.contains('active');
      if (!isOnGameScreen) {
        enterGameScreen(state);
      }
    }
  });

  // Header buttons
  document.getElementById('mute-btn').addEventListener('click', () => {
    const on = SoundManager.toggle();
    document.getElementById('mute-btn').textContent = on ? '🔊' : '🔇';
  });

  document.getElementById('save-game-btn').addEventListener('click', () => {
    SocketClient.saveGame();
  });

  document.getElementById('quit-game-btn').addEventListener('click', () => {
    if (confirm('Leave the game? Your progress will be preserved if saved.')) {
      SocketClient.leaveRoom();
      GameState.clear();
      showLobby();
    }
  });

  // Close property modal
  document.getElementById('close-property-modal').addEventListener('click', UIManager.closePropertyModal);

  // Close my-properties modal
  document.getElementById('close-my-props-modal').addEventListener('click', UIManager.closeMyPropertiesModal);

  // ── Trade modal ──────────────────────────────────────────────────────────

  document.getElementById('close-trade-modal').addEventListener('click', UIManager.closeTrade);
  document.getElementById('cancel-trade-modal-btn').addEventListener('click', UIManager.closeTrade);

  document.getElementById('send-trade-btn').addEventListener('click', () => {
    const toUserId      = document.getElementById('trade-target-player').value;
    const offerMoney    = Number(document.getElementById('trade-offer-money').value)   || 0;
    const offerCards    = Number(document.getElementById('trade-offer-cards').value)   || 0;
    const requestMoney  = Number(document.getElementById('trade-request-money').value) || 0;
    const requestCards  = Number(document.getElementById('trade-request-cards').value) || 0;
    const offerProps    = UIManager.getCheckedTradeProps('trade-offer-props');
    const requestProps  = UIManager.getCheckedTradeProps('trade-request-props');

    if (!toUserId) {
      UIManager.showError('trade-error', 'Please select a player to trade with');
      return;
    }

    SocketClient.sendTrade({ toUserId, offerMoney, offerProps, offerCards, requestMoney, requestProps, requestCards });
    UIManager.closeTrade();
  });

  // ── Incoming trade modal ─────────────────────────────────────────────────

  document.getElementById('accept-trade-btn').addEventListener('click', () => {
    SocketClient.acceptTrade();
    UIManager.closeIncomingTrade();
  });

  document.getElementById('reject-trade-btn').addEventListener('click', () => {
    SocketClient.rejectTrade();
    UIManager.closeIncomingTrade();
  });

  // ── Chat ─────────────────────────────────────────────────────────────────

  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text  = input.value.trim();
    if (text) {
      SocketClient.sendChat(text);
      input.value = '';
    }
  });

  // ── Game over modal ───────────────────────────────────────────────────────

  document.getElementById('back-to-lobby-btn').addEventListener('click', () => {
    document.getElementById('game-over-modal').style.display = 'none';
    SocketClient.leaveRoom();
    GameState.clear();
    showLobby();
  });

})();
