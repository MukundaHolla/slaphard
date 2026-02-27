import { CHANT_ORDER, type Card, type Gesture } from '@slaphard/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  initAudio,
  playClickSound,
  playFlipSound,
  playWinnerCelebrationSound,
  unlockAudio,
} from './audio';
import { createSocketApi, type SocketApi } from './socket';
import { useAppStore } from './store';

const gestureOptions: Gesture[] = ['GORILLA', 'NARWHAL', 'GROUNDHOG'];

const randomHex = (length: number): string => {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
};

const createClientEventId = (): string =>
  `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-a${randomHex(3)}-${randomHex(12)}`;

const CARD_META: Record<Card, { emoji: string; label: string }> = {
  TACO: { emoji: '🌮', label: 'Taco' },
  CAT: { emoji: '🐱', label: 'Cat' },
  GOAT: { emoji: '🐐', label: 'Goat' },
  CHEESE: { emoji: '🧀', label: 'Cheese' },
  PIZZA: { emoji: '🍕', label: 'Pizza' },
  GORILLA: { emoji: '🦍', label: 'Gorilla' },
  NARWHAL: { emoji: '🦄', label: 'Narwhal' },
  GROUNDHOG: { emoji: '🦫', label: 'Groundhog' },
};

const cardBadge = (card: Card | undefined): string => {
  if (!card) {
    return 'none';
  }
  const meta = CARD_META[card];
  return `${meta.emoji} ${meta.label}`;
};

const CONFETTI_COLORS = ['#ff5d3b', '#0e74ff', '#ff2f6d', '#42e3a4', '#ffcf2d', '#8b5cf6'] as const;

const ConfettiBurst = ({ seed }: { seed: string }) => {
  const pieces = useMemo(
    () =>
      Array.from({ length: 48 }, (_, index) => ({
        id: `${seed}-${index}`,
        left: `${Math.random() * 100}%`,
        delay: `${Math.random() * 1400}ms`,
        duration: `${5200 + Math.random() * 3200}ms`,
        drift: `${-160 + Math.random() * 320}px`,
        rotate: `${Math.random() * 720}deg`,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!,
      })),
    [seed],
  );

  return (
    <div className="confetti-layer" aria-hidden="true">
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="confetti-piece"
          style={
            {
              left: piece.left,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
              '--drift-x': piece.drift,
              '--spin': piece.rotate,
              background: piece.color,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
};

export const App = () => {
  const apiRef = useRef<SocketApi | null>(null);
  const finishCelebrationRef = useRef<string | undefined>(undefined);
  const [mobileStatsOpen, setMobileStatsOpen] = useState(false);

  const socketStatus = useAppStore((s) => s.socketStatus);
  const rejoinState = useAppStore((s) => s.rejoinState);
  const rejoinError = useAppStore((s) => s.rejoinError);
  const roomState = useAppStore((s) => s.roomState);
  const gameState = useAppStore((s) => s.gameState);
  const lastGameStateAt = useAppStore((s) => s.lastGameStateAt);
  const lastCardTakerUserId = useAppStore((s) => s.lastCardTakerUserId);
  const displayName = useAppStore((s) => s.displayName);
  const persistedRoomCode = useAppStore((s) => s.persistedRoomCode);
  const meUserId = useAppStore((s) => s.meUserId);
  const feed = useAppStore((s) => s.feed);
  const pingIntervalMs = useAppStore((s) => s.timeSync.pingIntervalMs);
  const rttAvg = useAppStore((s) => s.timeSync.rttAvg);
  const roomCodeInput = useAppStore((s) => s.ui.roomCodeInput);
  const homeStep = useAppStore((s) => s.ui.homeStep);
  const homeMode = useAppStore((s) => s.ui.homeMode);
  const selectedGesture = useAppStore((s) => s.ui.selectedGesture);
  const submittedSlapEventId = useAppStore((s) => s.ui.submittedSlapEventId);
  const feedCollapsed = useAppStore((s) => s.ui.feedCollapsed);

  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const setRoomCodeInput = useAppStore((s) => s.setRoomCodeInput);
  const setHomeStep = useAppStore((s) => s.setHomeStep);
  const setHomeMode = useAppStore((s) => s.setHomeMode);
  const setSelectedGesture = useAppStore((s) => s.setSelectedGesture);
  const clearRoom = useAppStore((s) => s.clearRoom);
  const setSocketStatus = useAppStore((s) => s.setSocketStatus);
  const setFeedCollapsed = useAppStore((s) => s.setFeedCollapsed);

  useEffect(() => {
    initAudio();
    const api = createSocketApi();
    apiRef.current = api;
    setSocketStatus('connecting');

    return () => {
      api.socket.disconnect();
      apiRef.current = null;
    };
  }, [setSocketStatus]);

  useEffect(() => {
    if (socketStatus !== 'connected') {
      return;
    }

    const id = setInterval(() => {
      apiRef.current?.ping();
    }, pingIntervalMs);

    return () => clearInterval(id);
  }, [pingIntervalMs, socketStatus]);

  useEffect(() => {
    const onPointer = () => unlockAudio();
    window.addEventListener('pointerdown', onPointer, { once: true });
    const onKeyDown = () => unlockAudio();
    window.addEventListener('keydown', onKeyDown, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button')) {
        playClickSound();
      }
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  const me = useMemo(
    () => gameState?.players.find((player) => player.userId === meUserId),
    [gameState?.players, meUserId],
  );

  const normalizedDisplayName = displayName.trim();
  const normalizedRoomCode = roomCodeInput.trim().toUpperCase();
  const canCreateRoom = normalizedDisplayName.length >= 2;
  const canJoinRoom = canCreateRoom && normalizedRoomCode.length === 6;
  const joinDisabledReason = !canCreateRoom
    ? 'Enter a display name (2-24 characters) to join from this browser.'
    : normalizedRoomCode.length !== 6
      ? 'Enter a 6-character room code.'
      : '';

  const slapActive = gameState?.slapWindow.active === true && gameState?.slapWindow.resolved === false;
  const isActionWindow = slapActive && gameState?.slapWindow.reason === 'ACTION';
  const isMyTurn = me && gameState ? me.seatIndex === gameState.currentTurnSeat : false;
  const canFlip = gameState?.status === 'IN_GAME' && isMyTurn && !slapActive;

  const isHost = roomState?.hostUserId === meUserId;

  useEffect(() => {
    if (gameState?.status !== 'FINISHED') {
      finishCelebrationRef.current = undefined;
      return;
    }
    if (!meUserId || gameState.winnerUserId !== meUserId) {
      return;
    }
    const celebrationKey = `${gameState.winnerUserId}:${gameState.version}`;
    if (finishCelebrationRef.current === celebrationKey) {
      return;
    }
    finishCelebrationRef.current = celebrationKey;
    playWinnerCelebrationSound();
  }, [gameState?.status, gameState?.version, gameState?.winnerUserId, meUserId]);

  useEffect(() => {
    const inActiveGame = roomState?.status === 'IN_GAME' && gameState?.status === 'IN_GAME';
    if (!inActiveGame) {
      document.body.classList.remove('game-active');
      return;
    }
    document.body.classList.add('game-active');
    return () => {
      document.body.classList.remove('game-active');
    };
  }, [gameState?.status, roomState?.status]);

  const leaveToHome = useCallback(() => {
    apiRef.current?.leaveRoom();
    clearRoom();
  }, [clearRoom]);

  const createFreshRoom = useCallback(() => {
    if (!canCreateRoom) {
      return;
    }
    apiRef.current?.leaveRoom();
    clearRoom();
    apiRef.current?.createRoom(normalizedDisplayName);
  }, [canCreateRoom, clearRoom, normalizedDisplayName]);

  const submitSlap = useCallback(() => {
    if (!gameState || gameState.status !== 'IN_GAME') {
      return;
    }
    const activeEventId =
      gameState.slapWindow.active && !gameState.slapWindow.resolved && gameState.slapWindow.eventId
        ? gameState.slapWindow.eventId
        : undefined;
    if (activeEventId && submittedSlapEventId === activeEventId) {
      return;
    }
    const eventId = activeEventId ?? createClientEventId();
    apiRef.current?.slap(eventId, isActionWindow ? selectedGesture : undefined);
  }, [gameState, isActionWindow, selectedGesture, submittedSlapEventId]);

  const submitCreateRoom = useCallback(() => {
    if (!canCreateRoom) {
      return;
    }
    apiRef.current?.createRoom(normalizedDisplayName);
  }, [canCreateRoom, normalizedDisplayName]);

  const submitJoinRoom = useCallback(() => {
    if (!canJoinRoom) {
      return;
    }
    apiRef.current?.joinRoom(normalizedRoomCode, normalizedDisplayName, meUserId);
  }, [canJoinRoom, meUserId, normalizedDisplayName, normalizedRoomCode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }
      if (event.repeat) {
        return;
      }
      event.preventDefault();
      submitSlap();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [submitSlap]);

  useEffect(() => {
    if (feedCollapsed) {
      return;
    }
    const timeoutId = window.setTimeout(() => setFeedCollapsed(true), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [feedCollapsed, setFeedCollapsed]);

  if (!roomState) {
    if (rejoinState === 'attempting' && persistedRoomCode) {
      return (
        <main className="home-shell">
          <section className="home-card">
            <h2>Reconnecting...</h2>
            <p className="muted">Rejoining room {persistedRoomCode}. Syncing latest game state.</p>
          </section>
        </main>
      );
    }

    return (
      <main className="home-shell">
        <section className="home-card">
          <h1>SlapHard</h1>
          <p className="muted">Socket: {socketStatus}</p>
          {rejoinState === 'failed' && rejoinError ? <p className="muted">{rejoinError}</p> : null}

          {homeStep === 'identity' ? (
            <section className="home-step">
              <label>
                Display Name
                <input
                  value={displayName}
                  maxLength={24}
                  minLength={2}
                  onChange={(event) => setDisplayName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canCreateRoom) {
                      playClickSound();
                      setHomeStep('roomAction');
                    }
                  }}
                />
              </label>
              <div className="row">
                <button className="btn primary" disabled={!canCreateRoom} onClick={() => setHomeStep('roomAction')}>
                  Continue
                </button>
              </div>
              {!canCreateRoom ? <p className="muted">Display name must be at least 2 characters.</p> : null}
            </section>
          ) : (
            <section className="home-step">
              <p className="muted">Choose room action for {normalizedDisplayName}.</p>
              <div className="home-mode-switch" role="tablist" aria-label="Room action mode">
                <button
                  className={homeMode === 'create' ? 'btn mode-tab active' : 'btn mode-tab'}
                  role="tab"
                  aria-selected={homeMode === 'create'}
                  onClick={() => setHomeMode('create')}
                >
                  Create
                </button>
                <button
                  className={homeMode === 'join' ? 'btn mode-tab active' : 'btn mode-tab'}
                  role="tab"
                  aria-selected={homeMode === 'join'}
                  onClick={() => setHomeMode('join')}
                >
                  Join
                </button>
              </div>

              <div className={homeMode === 'create' ? 'home-action-card active' : 'home-action-card'}>
                <h3>Create Room</h3>
                <p className="muted">Start a private room and share the code.</p>
                <button className="btn primary" disabled={!canCreateRoom} onClick={submitCreateRoom}>
                  Create Room
                </button>
              </div>

              <div className={homeMode === 'join' ? 'home-action-card active' : 'home-action-card'}>
                <h3>Join Room</h3>
                <label>
                  Join Code
                  <input
                    value={roomCodeInput}
                    maxLength={6}
                    onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canJoinRoom) {
                        playClickSound();
                        submitJoinRoom();
                      }
                    }}
                  />
                </label>
                <button className="btn" disabled={!canJoinRoom} onClick={submitJoinRoom}>
                  Join Room
                </button>
                {!canJoinRoom ? <p className="muted">{joinDisabledReason}</p> : null}
              </div>

              <div className="row">
                <button className="btn" onClick={() => setHomeStep('identity')}>
                  Back
                </button>
              </div>
            </section>
          )}
        </section>
      </main>
    );
  }

  if (roomState.status === 'LOBBY') {
    const hostPlayer = roomState.players.find((player) => player.userId === roomState.hostUserId);
    const hostLabel = hostPlayer
      ? `${hostPlayer.displayName} (${hostPlayer.userId.slice(0, 8)})`
      : roomState.hostUserId.slice(0, 8);

    return (
      <main className="home-shell">
        <section className="home-card">
          <h2>Lobby {roomState.roomCode}</h2>
          <p className="muted">Host: {hostLabel}</p>

          <ul className="players-list">
            {roomState.players.map((player) => (
              <li key={player.userId}>
                <span>{player.displayName}</span>
                <span>{player.connected ? 'online' : 'offline'}</span>
                <span>{player.ready ? 'ready' : 'not ready'}</span>
                <span className="player-actions">
                  {roomState.hostUserId === player.userId ? 'host' : null}
                  {isHost && roomState.hostUserId !== player.userId && !player.ready ? (
                    <button
                      className="btn lobby-kick"
                      onClick={() => apiRef.current?.kickFromLobby(player.userId)}
                    >
                      Kick
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          <div className="row">
            <button
              className="btn"
              onClick={() => {
                const self = roomState.players.find((player) => player.userId === meUserId);
                apiRef.current?.setReady(!(self?.ready ?? false));
              }}
            >
              Toggle Ready
            </button>
            <button className="btn primary" disabled={!isHost || roomState.players.length < 2} onClick={() => apiRef.current?.startGame()}>
              Start Game
            </button>
            <button className="btn danger" onClick={leaveToHome}>
              Leave
            </button>
            <button className="btn" disabled={!canCreateRoom} onClick={createFreshRoom}>
              New Room
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (roomState.status === 'IN_GAME' && socketStatus !== 'connected') {
    const lastUpdateSeconds =
      lastGameStateAt !== undefined ? Math.max(0, Math.floor((Date.now() - lastGameStateAt) / 1000)) : undefined;
    return (
      <main className="home-shell">
        <section className="home-card">
          <h2>Reconnecting To Game...</h2>
          <p className="muted">Connection dropped. Re-syncing room {roomState.roomCode}.</p>
          {lastUpdateSeconds !== undefined ? (
            <p className="muted">Last game-state update: {lastUpdateSeconds}s ago.</p>
          ) : null}
        </section>
      </main>
    );
  }

  if (!gameState) {
    return (
      <main className="home-shell">
        <section className="home-card">Waiting for game state...</section>
      </main>
    );
  }

  if (gameState.status === 'FINISHED') {
    const winner = gameState.players.find((player) => player.userId === gameState.winnerUserId);
    const standings = [...gameState.players].sort((a, b) => a.handCount - b.handCount || a.seatIndex - b.seatIndex);
    const winnerTitle = winner?.userId === meUserId ? 'You Win!' : 'Game Over';
    return (
      <main className="home-shell">
        <section className="home-card winner-card">
          <ConfettiBurst seed={gameState.winnerUserId ?? `fin-${gameState.version}`} />
          <div className="winner-headline">
            <span className="winner-crown" aria-hidden="true">
              👑
            </span>
            <h2>{winnerTitle}</h2>
            <p className="muted">Room {roomState.roomCode}</p>
          </div>
          <div className="winner-highlight">
            <p className="muted">Champion</p>
            <h3>{winner?.displayName ?? gameState.winnerUserId}</h3>
          </div>
          <ul className="winner-standings">
            {standings.map((player, index) => (
              <li key={player.userId}>
                <span>{index + 1}. {player.displayName}</span>
                <strong>{player.handCount} cards</strong>
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn primary" onClick={() => apiRef.current?.stopGame()}>
              Return to Lobby
            </button>
            <button className="btn danger" onClick={leaveToHome}>
              Back Home
            </button>
            <button className="btn" disabled={!canCreateRoom} onClick={createFreshRoom}>
              New Room
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (gameState.status !== 'IN_GAME') {
    return (
      <main className="home-shell">
        <section className="home-card">
          <h2>Syncing Game State...</h2>
          <p className="muted">Waiting for in-game snapshot from server for room {roomState.roomCode}.</p>
          <div className="row">
            <button className="btn danger" onClick={leaveToHome}>
              Leave Room
            </button>
          </div>
        </section>
      </main>
    );
  }

  const currentChant = CHANT_ORDER[gameState.chantIndex]!;
  const flipDisabledReason = gameState.status !== 'IN_GAME'
    ? 'Game is not active.'
    : slapActive
      ? 'Wait for slap window to resolve.'
      : !isMyTurn
        ? 'Not your turn.'
        : '';
  const currentTurnName =
    gameState.players.find((player) => player.seatIndex === gameState.currentTurnSeat)?.displayName ??
    `Seat ${gameState.currentTurnSeat}`;
  const lastCardTakerLabel = (() => {
    if (!lastCardTakerUserId) {
      return 'none';
    }
    const known = gameState.players.find((player) => player.userId === lastCardTakerUserId);
    return known?.displayName ?? lastCardTakerUserId.slice(0, 8);
  })();

  return (
      <main className="game-shell">
        <section className="table-card">
          <button
            className={mobileStatsOpen ? 'btn stats-toggle active' : 'btn stats-toggle'}
            onClick={() => setMobileStatsOpen((open) => !open)}
            aria-expanded={mobileStatsOpen}
            aria-controls="mobile-stats"
          >
            {mobileStatsOpen ? 'Hide Stats' : 'Show Stats'}
          </button>

          <header id="mobile-stats" className={mobileStatsOpen ? 'status-micro-strip open' : 'status-micro-strip collapsed-mobile'}>
            <div className="status-micro-chip">
              <strong>Room</strong>
              <span>{roomState.roomCode}</span>
            </div>
            <div className="status-micro-chip">
              <strong>Turn</strong>
              <span>{currentTurnName}</span>
            </div>
            <div className="status-micro-chip">
              <strong>Pile</strong>
              <span>{gameState.pileCount}</span>
            </div>
            <div className="status-micro-chip">
              <strong>Latency</strong>
              <span>{Math.round(rttAvg)}ms</span>
            </div>
          </header>

          <section className="action-zone compact">
            <div className="card-preview chant-card">
              <p>Current Card</p>
              <h3>{cardBadge(currentChant)}</h3>
            </div>

            <div className="card-preview">
              <p>Last Card</p>
              <h3>{cardBadge(gameState.lastRevealed?.card)}</h3>
            </div>
          </section>

          <section className="action-reference" aria-label="Special card reference">
            <p>Special Cards</p>
            <div className="action-reference-grid">
              {gestureOptions.map((gesture) => (
                <span key={gesture} className="action-reference-chip">
                  {cardBadge(gesture)}
                </span>
              ))}
            </div>
          </section>

          <section className="holders-micro" aria-label="Card holders">
            {gameState.players.map((player) => (
              <span
                key={player.userId}
                className={player.userId === meUserId ? 'holders-chip me' : 'holders-chip'}
              >
                {player.displayName}: {player.handCount}
              </span>
            ))}
          </section>

          <section className="mini-stats">
            <div className="stat-pill">
              <span className="stat-label">Your Hand</span>
              <strong>{me?.handCount ?? 0}</strong>
            </div>
            <div className="stat-pill">
              <span className="stat-label">Last Card Taker</span>
              <strong>{lastCardTakerLabel}</strong>
            </div>
          </section>

          {isActionWindow ? (
            <section className="gesture-zone" aria-label="Action selection">
              <p>Required action: {cardBadge(gameState.slapWindow.actionCard)}</p>
              <div className="gesture-grid">
                {gestureOptions.map((gesture) => (
                  <button
                    key={gesture}
                    className={selectedGesture === gesture ? 'btn gesture active' : 'btn gesture'}
                    aria-label={`Select ${gesture}`}
                    onClick={() => setSelectedGesture(gesture)}
                  >
                    {cardBadge(gesture)}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="controls-zone fixed-controls">
            <button
              className="btn xlarge flip"
              disabled={!canFlip}
              onClick={() => {
                playFlipSound();
                apiRef.current?.flip();
              }}
            >
              FLIP
            </button>

            <button className="btn xlarge slap" onClick={submitSlap}>
              SLAP (Space)
            </button>
          </section>

          <section className="control-hints" aria-live="polite">
            {!canFlip && flipDisabledReason ? <p className="muted">Flip disabled: {flipDisabledReason}</p> : null}
            {!slapActive ? <p className="muted">No slap window open. Slapping now is a false slap penalty.</p> : null}
            {slapActive && submittedSlapEventId === gameState.slapWindow.eventId ? (
              <p className="muted">You already slapped this event. Extra slaps are ignored.</p>
            ) : null}
            {slapActive && gameState.slapWindow.reason === 'SAME_CARD' ? (
              <p className="muted">Same card round: waiting for every connected player to slap.</p>
            ) : null}
            {isActionWindow && !selectedGesture ? (
              <p className="muted">No action selected. Slapping now will count as wrong gesture.</p>
            ) : null}
          </section>

          <section className="secondary-controls">
            {isHost ? (
              <button className="btn danger" onClick={() => apiRef.current?.stopGame()}>
                Stop Game
              </button>
            ) : null}
            <button className="btn" onClick={leaveToHome}>
              Leave Room
            </button>
            <button className="btn" disabled={!canCreateRoom} onClick={createFreshRoom}>
              New Room
            </button>
            <button
              className="btn"
              onClick={() => setFeedCollapsed(!feedCollapsed)}
              aria-label={feedCollapsed ? 'Show feed' : 'Hide feed'}
            >
              {feedCollapsed ? 'Show Feed' : 'Hide Feed'}
            </button>
          </section>
        </section>

      <aside className={feedCollapsed ? 'feed-drawer collapsed' : 'feed-drawer'}>
        <div className="feed-header">
          <h3>Game Feed</h3>
          <button className="btn feed-close" onClick={() => setFeedCollapsed(true)}>
            Close
          </button>
        </div>
        <ul>
          {feed.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      </aside>
    </main>
  );
};
