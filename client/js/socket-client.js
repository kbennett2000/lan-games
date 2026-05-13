/**
 * socket-client.js
 *
 * Manages the Socket.io connection and all real-time server events.
 * Translates incoming events into GameState updates and UI notifications.
 *
 * This module is initialized by app.js after login and provides a clean
 * API for game actions so the rest of the client never touches the raw socket.
 */

const SocketClient = (() => {

  let socket = null;
  let _onLobbyUpdate = null;

  // ── connect ────────────────────────────────────────────────────────────────

  /**
   * Open a Socket.io connection, passing the JWT in the handshake.
   * Must be called once after the user logs in.
   */
  function connect(onReady) {
    if (socket && socket.connected) {
      onReady?.();
      return;
    }

    socket = io({
      auth: { token: API.getToken() },
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
      console.log('[socket] connected', socket.id);
      onReady?.();
    });

    socket.on('connect_error', (err) => {
      console.error('[socket] connection error:', err.message);
      // If auth fails, force back to login
      if (err.message.includes('token') || err.message.includes('auth')) {
        API.clearToken();
        UIManager.showScreen('auth-screen');
      }
    });

    socket.on('disconnect', (reason) => {
      console.warn('[socket] disconnected:', reason);
    });

    // Auto-rejoin the game room after a network hiccup reconnects the socket.
    // The server will send game:state which re-syncs all UI.
    socket.on('reconnect', () => {
      console.log('[socket] reconnected, rejoining game room');
      const gameId = GameState.getGameId();
      if (gameId) {
        socket.emit('join_game', gameId, (res) => {
          if (res?.error) console.error('[socket] auto-rejoin failed:', res.error);
        });
      }
    });

    socket.on('auth:error', ({ message }) => {
      console.error('[socket] auth error:', message);
      API.clearToken();
      UIManager.showScreen('auth-screen');
    });

    // ── game state events ──────────────────────────────────────────────────

    // Full state sync (sent when joining a game room)
    socket.on('game:state', ({ state }) => {
      GameState.setState(state);
      handleFullStateUpdate(state);
    });

    // Incremental update (sent after every game action)
    socket.on('game:update', ({ state, events }) => {
      GameState.setState(state);
      handleFullStateUpdate(state);

      // Process events for visual effects and log entries
      for (const ev of (events || [])) {
        handleGameEvent(ev, state);
      }
    });

    socket.on('game:error', ({ message }) => {
      const activeRenderer = GameRendererRegistry.getActive();
      if (activeRenderer?.onEvent) {
        // Deliver ACTION_REJECTED to the active renderer; it owns the user-facing feedback.
        activeRenderer.onEvent(
          { type: 'ACTION_REJECTED', data: { message }, timestamp: Date.now() },
          GameState.getState()
        );
      } else {
        // Legacy fallback for non-registry renderers (Monopoly pre-migration).
        UIManager.appendLog(`⚠ ${message}`, 'info');
        const actionsEl = document.getElementById('action-buttons');
        if (actionsEl) {
          actionsEl.style.outline = '2px solid #e53935';
          setTimeout(() => { actionsEl.style.outline = ''; }, 1000);
        }
      }
    });

    socket.on('game:saved', ({ savedBy }) => {
      UIManager.appendLog(`Game saved by ${savedBy}`, 'info');
    });

    // ── trade events ───────────────────────────────────────────────────────

    socket.on('trade:incoming', ({ from, payload }) => {
      // State update will also arrive via game:update, so we just need the modal
      const state = GameState.getState();
      if (state?.trade) {
        UIManager.showIncomingTrade(state, GameState.getUser()?.id);
      }
    });

    // ── chat ───────────────────────────────────────────────────────────────

    socket.on('chat:message', ({ username, text }) => {
      UIManager.appendChat(username, text);
    });

    socket.on('lobby:update', () => {
      if (_onLobbyUpdate) _onLobbyUpdate();
    });

    socket.on('game:turn_warning', ({ username, secondsRemaining }) => {
      UIManager.appendLog(`⏱ ${username} disconnected — turn auto-skips in ${secondsRemaining}s`, 'info');
    });

  } // end connect()

  // ── full state update handler ──────────────────────────────────────────────

  function handleFullStateUpdate(state) {
    if (!state) return;

    const myUserId       = GameState.getUser()?.id;
    const activeRenderer = GameRendererRegistry.getActive();

    // Show the correct screen if the game status changed
    if (state.status === 'waiting') {
      UIManager.showScreen('waiting-screen');
      const nameEl = document.getElementById('waiting-game-name');
      if (nameEl && state.name) nameEl.textContent = state.name;
      UIManager.renderWaitingPlayers(state, myUserId, state.createdBy);
    } else if (state.status === 'playing' || state.status === 'paused') {
      const gameScreenActive = document.getElementById('game-screen').classList.contains('active');
      if (!gameScreenActive) {
        UIManager.showScreen('game-screen');
        // Init the renderer for this game type (only once per game join).
        const renderer = GameRendererRegistry.get(state.gameType);
        if (renderer) {
          GameRendererRegistry.setActive(renderer);
          renderer.init(document.querySelector('.board-wrapper'), state, myUserId, action);
        }
        UIManager.appendLogsFromState(state);
      }
    }

    if (state.status === 'playing') {
      UIManager.updatePlayerPanels(state);
      UIManager.updateTurnIndicator(state, myUserId);
      GameRendererRegistry.getActive()?.update(state);
    }

    if (state.status === 'finished') {
      // Generic winner lookup: prefer state.winner (userId), fall back to Monopoly isBankrupt check.
      let winnerName;
      if (state.winner !== undefined && state.winner !== null) {
        winnerName = state.players.find(p => p.userId === state.winner)?.username;
      } else if (state.winner === null) {
        winnerName = null; // draw
      } else {
        winnerName = state.players.find(p => !p.isBankrupt)?.username;
      }
      // Let the active renderer disable its controls on game over.
      GameRendererRegistry.getActive()?.update(state);
      UIManager.showGameOver(winnerName);
    }
  }

  // ── game event visual handler ──────────────────────────────────────────────

  function handleGameEvent(ev, state) {
    // Deliver to the active renderer first (handles game-specific events
    // such as ACTION_REJECTED, PIECE_DROPPED, and game-specific GAME_OVER logs).
    const activeRenderer = GameRendererRegistry.getActive();
    if (activeRenderer?.onEvent) {
      activeRenderer.onEvent(ev, state);
    }

    // Framework always handles these generic events regardless of renderer.
    switch (ev.type) {
      case 'PLAYER_CONNECTED':
        UIManager.appendLog(`${ev.data.username} reconnected`, 'info');
        return;
      case 'TURN_SKIPPED':
        UIManager.appendLog(`⏭ ${ev.data.username}'s turn was auto-skipped (disconnected)`, 'info');
        return;
      case 'PLAYER_DISCONNECTED':
        UIManager.appendLog(`${ev.data.username} disconnected`, 'info');
        return;
    }

  }

  // ── action emitters ────────────────────────────────────────────────────────

  function emit(event, data) {
    if (!socket) { console.warn('[socket] not connected'); return; }
    socket.emit(event, data);
  }

  function action(name, payload = {}) {
    emit('game:action', { action: name, ...payload });
  }

  // ── lobby / game room socket events ───────────────────────────────────────

  /** Join the Socket.io room for a game. */
  function joinGameRoom(gameId, callback) {
    socket.emit('join_game', gameId, (res) => {
      if (res?.error) { callback?.(res.error); }
      else            { callback?.(null); }
    });
  }

  function joinLobby(gameId, callback) {
    socket.emit('lobby:join', gameId, (res) => {
      if (res?.error) callback?.(res.error);
      else {
        if (res?.state) {
          GameState.setState(res.state);
          handleFullStateUpdate(res.state);
        }
        callback?.(null);
      }
    });
  }

  function startGame() { emit('game:start'); }
  function saveGame()  { emit('game:save', undefined); }
  function leaveRoom() { emit('leave_game'); }

  function sendChat(text) { emit('chat:message', { text }); }

  function onLobbyUpdate(fn) { _onLobbyUpdate = fn; }

  // ── host id helper ─────────────────────────────────────────────────────────

  // Stored separately because the game state doesn't always include created_by
  let _hostId = null;
  function setHostId(id) { _hostId = id; }
  function getHostId()   { return _hostId; }

  // ── public API ─────────────────────────────────────────────────────────────

  return {
    connect,
    onLobbyUpdate,
    joinGameRoom,
    joinLobby,
    startGame,
    saveGame,
    leaveRoom,
    sendChat,
    setHostId,
    getHostId,
    emitAction: (name, payload = {}) => action(name, payload),
  };

})();
