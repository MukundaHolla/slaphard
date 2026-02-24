import { CHANT_ORDER, type Card, type Gesture } from '@slaphard/shared';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  initAudio,
  playClickSound,
  playFlipSound,
  playSlapSound,
  playWinSound,
  unlockAudio,
} from './audio';
import { createSocketApi, type SocketApi } from './socket';
import { getPersistedIdentity, useAppStore } from './store';

const gestureOptions: Gesture[] = ['GORILLA', 'NARWHAL', 'GROUNDHOG'];

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

export const App = () => {
  const apiRef = useRef<SocketApi | null>(null);

  const socketStatus = useAppStore((s) => s.socketStatus);
  const roomState = useAppStore((s) => s.roomState);
  const gameState = useAppStore((s) => s.gameState);
  const displayName = useAppStore((s) => s.displayName);
  const meUserId = useAppStore((s) => s.meUserId);
  const feed = useAppStore((s) => s.feed);
  const pingIntervalMs = useAppStore((s) => s.timeSync.pingIntervalMs);
  const rttAvg = useAppStore((s) => s.timeSync.rttAvg);
  const offsetAvg = useAppStore((s) => s.timeSync.offsetAvg);
  const roomCodeInput = useAppStore((s) => s.ui.roomCodeInput);
  const selectedGesture = useAppStore((s) => s.ui.selectedGesture);
  const submittedSlapEventId = useAppStore((s) => s.ui.submittedSlapEventId);
  const feedCollapsed = useAppStore((s) => s.ui.feedCollapsed);

  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const setRoomCodeInput = useAppStore((s) => s.setRoomCodeInput);
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
    if (socketStatus !== 'connected' || roomState) {
      return;
    }

    const persisted = getPersistedIdentity();
    if (!persisted.roomCode || !persisted.displayName) {
      return;
    }

    apiRef.current?.joinRoom(persisted.roomCode, persisted.displayName, persisted.userId);
  }, [roomState, socketStatus]);

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
  const canSlap =
    slapActive &&
    !!gameState?.slapWindow.eventId &&
    submittedSlapEventId !== gameState.slapWindow.eventId &&
    (!isActionWindow || !!selectedGesture);

  const isHost = roomState?.hostUserId === meUserId;

  useEffect(() => {
    if (gameState?.status === 'FINISHED' && gameState.winnerUserId === meUserId) {
      playWinSound();
    }
  }, [gameState?.status, gameState?.winnerUserId, meUserId]);

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
    if (!gameState?.slapWindow.eventId || !canSlap) {
      return;
    }
    playSlapSound();
    apiRef.current?.slap(gameState.slapWindow.eventId, isActionWindow ? selectedGesture : undefined);
  }, [canSlap, gameState?.slapWindow.eventId, isActionWindow, selectedGesture]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }
      event.preventDefault();
      submitSlap();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [submitSlap]);

  if (!roomState) {
    return (
      <main className="home-shell">
        <section className="home-card">
          <h1>SlapHard</h1>
          <p className="muted">Socket: {socketStatus}</p>

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
                  apiRef.current?.createRoom(normalizedDisplayName);
                }
              }}
            />
          </label>

          <div className="row">
            <button className="btn primary" disabled={!canCreateRoom} onClick={() => apiRef.current?.createRoom(normalizedDisplayName)}>
              Create Room
            </button>
          </div>
          {!canCreateRoom ? <p className="muted">Display name must be at least 2 characters.</p> : null}

          <label>
            Join Code
            <input
              value={roomCodeInput}
              maxLength={6}
              onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canJoinRoom) {
                  playClickSound();
                  apiRef.current?.joinRoom(normalizedRoomCode, normalizedDisplayName, meUserId);
                }
              }}
            />
          </label>

          <div className="row">
            <button className="btn" disabled={!canJoinRoom} onClick={() => apiRef.current?.joinRoom(normalizedRoomCode, normalizedDisplayName, meUserId)}>
              Join Room
            </button>
          </div>
          {!canJoinRoom ? <p className="muted">{joinDisabledReason}</p> : null}
        </section>
      </main>
    );
  }

  if (roomState.status === 'LOBBY') {
    return (
      <main className="home-shell">
        <section className="home-card">
          <h2>Lobby {roomState.roomCode}</h2>
          <p className="muted">Host: {roomState.hostUserId.slice(0, 8)}</p>

          <ul className="players-list">
            {roomState.players.map((player) => (
              <li key={player.userId}>
                <span>{player.displayName}</span>
                <span>{player.connected ? 'online' : 'offline'}</span>
                <span>{player.ready ? 'ready' : 'not ready'}</span>
                <span>{roomState.hostUserId === player.userId ? 'host' : ''}</span>
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

  if (!gameState) {
    return (
      <main className="home-shell">
        <section className="home-card">Waiting for game state...</section>
      </main>
    );
  }

  if (gameState.status === 'FINISHED') {
    const winner = gameState.players.find((player) => player.userId === gameState.winnerUserId);
    return (
      <main className="home-shell">
        <section className="home-card">
          <h2>Game Over</h2>
          <p>Winner: {winner?.displayName ?? gameState.winnerUserId}</p>
          <div className="row">
            {isHost ? <button className="btn primary" onClick={() => apiRef.current?.stopGame()}>Return to Lobby</button> : null}
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

  const currentChant = CHANT_ORDER[gameState.chantIndex]!;
  const flipDisabledReason = gameState.status !== 'IN_GAME'
    ? 'Game is not active.'
    : slapActive
      ? 'Wait for slap window to resolve.'
      : !isMyTurn
        ? 'Not your turn.'
        : '';
  const slapDisabledReason = !slapActive
    ? 'No slap window open.'
    : submittedSlapEventId === gameState.slapWindow.eventId
      ? 'You already slapped this event.'
      : isActionWindow && !selectedGesture
        ? 'Select the required action first.'
        : '';
  const myPlace = (() => {
    const latestResult = feed.find((entry) => entry.startsWith('slap result:'));
    if (!latestResult) {
      return 'none';
    }
    const found = latestResult.match(/you=(\w+)/);
    return found?.[1] ?? 'none';
  })();

  return (
    <main className="game-shell">
      <section className="table-card">
        <header className="status-strip">
          <div className="status-chip">
            <strong>Room</strong>
            <span>{roomState.roomCode}</span>
          </div>
          <div className="status-chip">
            <strong>Turn</strong>
            <span>Seat {gameState.currentTurnSeat}</span>
          </div>
          <div className="status-chip">
            <strong>Chant</strong>
            <span>{cardBadge(currentChant)}</span>
          </div>
          <div className="status-chip">
            <strong>Pile</strong>
            <span>{gameState.pileCount}</span>
          </div>
          <div className="status-chip">
            <strong>Latency</strong>
            <span>{Math.round(rttAvg)}ms / {Math.round(offsetAvg)}ms</span>
          </div>
        </header>

        <section className="action-zone">
          <div className="card-preview">
            <p>Last Revealed</p>
            <h3>{cardBadge(gameState.lastRevealed?.card)}</h3>
          </div>

          <div className="card-preview">
            <p>Your Hand</p>
            <h3>{me?.handCount ?? 0} cards</h3>
          </div>

          <div className="card-preview">
            <p>Your Last Slap Place</p>
            <h3>{myPlace}</h3>
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

        <section className="controls-zone">
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

          <button className="btn xlarge slap" disabled={!canSlap} onClick={submitSlap}>
            SLAP (Space)
          </button>
        </section>

        <section className="control-hints" aria-live="polite">
          {!canFlip && flipDisabledReason ? <p className="muted">Flip disabled: {flipDisabledReason}</p> : null}
          {!canSlap && slapDisabledReason ? <p className="muted">Slap disabled: {slapDisabledReason}</p> : null}
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
        <h3>Game Feed</h3>
        <ul>
          {feed.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      </aside>
    </main>
  );
};
