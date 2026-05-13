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
        // Build the game-type-appropriate board (only once per game join).
        const renderer = GameRendererRegistry.get(state.gameType);
        if (renderer) {
          GameRendererRegistry.setActive(renderer);
          renderer.init(document.querySelector('.board-wrapper'), state, myUserId, action);
        } else {
          // Monopoly (pre-migration legacy path)
          BoardRenderer.buildBoard(state.config.board, (pos) => {
            UIManager.showPropertyModal(pos, GameState.getState(), myUserId, getPropertyHandlers());
          });
        }
        UIManager.appendLogsFromState(state);
      }
    }

    if (state.status === 'playing') {
      UIManager.updatePlayerPanels(state);
      UIManager.updateTurnIndicator(state, myUserId);

      const renderer = GameRendererRegistry.getActive();
      if (renderer) {
        renderer.update(state);
      } else {
        // Monopoly (pre-migration legacy path)
        BoardRenderer.update(state);
        UIManager.updateActionPanel(state, myUserId, getActionHandlers());

        if (state.trade && state.trade.status === 'pending' && state.trade.toUserId === myUserId) {
          UIManager.showIncomingTrade(state, myUserId);
        } else {
          UIManager.closeIncomingTrade();
        }
      }
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
    const myUsername = GameState.getUser()?.username;

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

    // If there is an active renderer it handled game-specific events above; skip the legacy path.
    if (activeRenderer) return;

    // ── Monopoly (pre-migration) legacy event handling ─────────────────────
    switch (ev.type) {
      case 'DICE_ROLLED':
        SoundManager.playDice();
        break;
      case 'PLAYER_MOVED':
        BoardRenderer.flashSquare(ev.data.to);
        break;
      case 'PLAYER_LANDED':
        UIManager.appendLog(`${ev.data.username} landed on ${ev.data.squareName}`, 'move');
        break;
      case 'PASSED_GO':
        SoundManager.playBigCollect();
        break;
      case 'PLAYER_JAILED':
        UIManager.appendLog(`🚔 ${ev.data.username} was sent to Jail!`, 'jail');
        SoundManager.playJail();
        break;
      case 'PLAYER_FREED_FROM_JAIL':
        UIManager.appendLog(`${ev.data.username} got out of Jail`, 'jail');
        SoundManager.playFreeJail();
        break;
      case 'JAIL_FINE_PAID':
        SoundManager.playPay(false);
        break;
      case 'PROPERTY_BOUGHT':
        UIManager.appendLog(`${ev.data.username} bought ${ev.data.name} for $${ev.data.price}`, 'property');
        SoundManager.playBuy();
        break;
      case 'AUCTION_STARTED':
        UIManager.appendLog(`🔔 Auction: ${ev.data.name} (min bid $${ev.data.minBid})`, 'auction');
        break;
      case 'AUCTION_WON':
        UIManager.appendLog(`${ev.data.username} won ${ev.data.name} at auction for $${ev.data.amount}`, 'auction');
        if (ev.data.username === myUsername) SoundManager.playBigCollect();
        else                                 SoundManager.playBuy();
        break;
      case 'MONOPOLY_ACHIEVED':
        UIManager.appendLog(`🏆 ${ev.data.username} has a monopoly on ${ev.data.colorGroup}!`, 'property');
        SoundManager.playMonopoly();
        break;
      case 'RENT_PAID': {
        UIManager.appendLog(`${ev.data.from} paid $${ev.data.amount} rent to ${ev.data.to}`, 'money');
        const big = ev.data.amount >= 100;
        if (ev.data.to   === myUsername) SoundManager.playCollect();
        else if (ev.data.from === myUsername) SoundManager.playPay(big);
        break;
      }
      case 'FREE_PARKING_COLLECTED':
        UIManager.appendLog(`🅿 ${ev.data.username} collected $${ev.data.amount} from Free Parking!`, 'money');
        SoundManager.playBigCollect();
        break;
      case 'MONEY_RECEIVED':
        UIManager.appendLog(`${ev.data.username} collected $${ev.data.amount}`, 'money');
        if (ev.data.username === myUsername) SoundManager.playCollect();
        break;
      case 'CARD_DRAWN':
        UIManager.appendLog(`🃏 ${ev.data.username}: "${ev.data.card.text}"`, 'card');
        SoundManager.playCard();
        break;
      case 'BUILDING_BUILT':
        UIManager.appendLog(`🏠 ${ev.data.username} built a ${ev.data.buildingType} on ${ev.data.name}`, 'property');
        SoundManager.playBuild();
        break;
      case 'BUILDING_SOLD':
        UIManager.appendLog(`${ev.data.username} sold a ${ev.data.buildingType} on ${ev.data.name} for $${ev.data.sellPrice}`, 'property');
        break;
      case 'PROPERTY_MORTGAGED':
        UIManager.appendLog(`${ev.data.username} mortgaged ${ev.data.name}`, 'property');
        break;
      case 'PROPERTY_UNMORTGAGED':
        UIManager.appendLog(`${ev.data.username} unmortgaged ${ev.data.name}`, 'property');
        break;
      case 'TRADE_OFFERED':
        UIManager.appendLog(`🤝 ${ev.data.from} offered a trade to ${ev.data.to}`, 'trade');
        break;
      case 'TRADE_ACCEPTED':
        UIManager.appendLog(`Trade between ${ev.data.from} and ${ev.data.to} completed`, 'trade');
        SoundManager.playCollect();
        break;
      case 'TRADE_REJECTED':
        UIManager.appendLog(`${ev.data.to} rejected ${ev.data.from}'s trade`, 'trade');
        break;
      case 'PLAYER_BANKRUPT':
        UIManager.appendLog(`💸 ${ev.data.username} is bankrupt!`, 'game');
        SoundManager.playBankrupt();
        break;
      case 'GAME_OVER':
        UIManager.appendLog(ev.data.winner ? `🏆 ${ev.data.winner} wins the game!` : "🤝 It's a draw!", 'game');
        SoundManager.playGameOver();
        break;
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

  function getActionHandlers() {
    return {
      rollDice:           () => action('rollDice'),
      buyProperty:        () => action('buyProperty'),
      declinePurchase:    () => action('declinePurchase'),
      placeBid:      (amt) => action('placeBid', { amount: amt }),
      passAuction:        () => action('passAuction'),
      endTurn:            () => action('endTurn'),
      payJailFine:        () => action('payJailFine'),
      useJailCard:        () => action('useJailCard'),
      openPropertyModal:  () => showMyPropertiesModal(),
      openTradeModal:     () => UIManager.showTradeModal(GameState.getState(), GameState.getUser()?.id),
      declareBankruptcy:  () => {
        if (confirm('Are you sure you want to declare bankruptcy? You will be eliminated from the game.')) {
          action('declareBankruptcy');
        }
      },
    };
  }

  function getPropertyHandlers() {
    return {
      buildHouse:         (pos) => action('buildHouse', { position: pos }),
      sellHouse:          (pos) => action('sellHouse', { position: pos }),
      mortgageProperty:   (pos) => action('mortgageProperty', { position: pos }),
      unmortgageProperty: (pos) => action('unmortgageProperty', { position: pos }),
    };
  }

  // Show a modal listing all my properties for management
  function showMyPropertiesModal() {
    const state    = GameState.getState();
    const myUserId = GameState.getUser()?.id;
    if (!state || !myUserId) return;

    const myProps = Object.keys(state.properties)
      .filter(pos => state.properties[pos].ownerId === myUserId)
      .map(Number)
      .sort((a, b) => a - b);

    if (myProps.length === 0) {
      UIManager.appendLog('You own no properties.', 'info');
      return;
    }

    UIManager.showMyPropertiesModal(myProps, state, myUserId, getPropertyHandlers());
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

  function sendTrade(payload) { action('offerTrade', payload); }
  function acceptTrade()      { action('acceptTrade'); }
  function rejectTrade()      { action('rejectTrade'); }
  function cancelTrade()      { action('cancelTrade'); }

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
    sendTrade,
    acceptTrade,
    rejectTrade,
    cancelTrade,
    setHostId,
    getHostId,
    getActionHandlers,
    getPropertyHandlers,
    emitAction: (name, payload = {}) => action(name, payload),
  };

})();
