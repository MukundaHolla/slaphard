import { CHANT_ORDER, type Card, type Gesture } from '@slaphard/shared';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createSocketApi, type SocketApi } from './socket';
import { playClickSound, playFlipSound, playSlapSound } from './sound';
import { getPersistedIdentity, useAppStore } from './store';

const gestureOptions: Gesture[] = ['GORILLA', 'NARWHAL', 'GROUNDHOG'];
const CARD_EMOJI: Record<Card, string> = {
  TACO: '🌮',
  CAT: '🐱',
  GOAT: '🐐',
  CHEESE: '🧀',
  PIZZA: '🍕',
  GORILLA: '🦍',
  NARWHAL: '🦄',
  GROUNDHOG: '🦫',
};

export const App = () => {
  const apiRef = useRef<SocketApi | null>(null);

  const socketStatus = useAppStore((s) => s.socketStatus);
  const roomState = useAppStore((s) => s.roomState);
  const gameState = useAppStore((s) => s.gameState);
  const displayName = useAppStore((s) => s.displayName);
  const meUserId = useAppStore((s) => s.meUserId);
  const roomCodeInput = useAppStore((s) => s.ui.roomCodeInput);
  const selectedGesture = useAppStore((s) => s.ui.selectedGesture);
  const submittedSlapEventId = useAppStore((s) => s.ui.submittedSlapEventId);
  const feed = useAppStore((s) => s.feed);
  const pingIntervalMs = useAppStore((s) => s.timeSync.pingIntervalMs);
  const rttAvg = useAppStore((s) => s.timeSync.rttAvg);
  const offsetAvg = useAppStore((s) => s.timeSync.offsetAvg);

  const setDisplayName = useAppStore((s) => s.setDisplayName);
  const setRoomCodeInput = useAppStore((s) => s.setRoomCodeInput);
  const setSelectedGesture = useAppStore((s) => s.setSelectedGesture);
  const clearRoom = useAppStore((s) => s.clearRoom);
  const setSocketStatus = useAppStore((s) => s.setSocketStatus);

  useEffect(() => {
    setSocketStatus('connecting');
    const api = createSocketApi();
    apiRef.current = api;

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

  const slapActive = gameState?.slapWindow.active === true && gameState?.slapWindow.resolved === false;
  const isActionWindow = slapActive && gameState?.slapWindow.reason === 'ACTION';
  const isMyTurn = me && gameState ? me.seatIndex === gameState.currentTurnSeat : false;
  const canFlip = gameState?.status === 'IN_GAME' && isMyTurn && !slapActive;
  const normalizedDisplayName = displayName.trim();
  const normalizedRoomCode = roomCodeInput.trim().toUpperCase();
  const canCreateRoom = normalizedDisplayName.length >= 2;
  const canJoinRoom = canCreateRoom && normalizedRoomCode.length === 6;
  const canSlap =
    slapActive &&
    !!gameState?.slapWindow.eventId &&
    submittedSlapEventId !== gameState.slapWindow.eventId &&
    (!isActionWindow || !!selectedGesture);

  const formatCard = (card: Card | undefined): string => (card ? `${CARD_EMOJI[card]} ${card}` : 'none');

  const submitSlap = useCallback(() => {
    if (!gameState?.slapWindow.eventId || !canSlap) {
      return;
    }

    playSlapSound();
    const gesture = isActionWindow ? selectedGesture : undefined;
    apiRef.current?.slap(gameState.slapWindow.eventId, gesture);
  }, [canSlap, gameState?.slapWindow.eventId, isActionWindow, selectedGesture]);

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
      <main className="app">
        <section className="panel">
          <h1>SlapHard</h1>
          <p className="muted">Status: {socketStatus}</p>

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
            <button
              disabled={!canCreateRoom}
              onClick={() => apiRef.current?.createRoom(normalizedDisplayName)}
            >
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
            <button
              disabled={!canJoinRoom}
              onClick={() => apiRef.current?.joinRoom(normalizedRoomCode, normalizedDisplayName, meUserId)}
            >
              Join Room
            </button>
          </div>
          {canCreateRoom && normalizedRoomCode.length > 0 && normalizedRoomCode.length !== 6 ? (
            <p className="muted">Room code must be exactly 6 characters.</p>
          ) : null}
        </section>
      </main>
    );
  }

  if (roomState.status === 'LOBBY') {
    return (
      <main className="app">
        <section className="panel">
          <h2>Lobby {roomState.roomCode}</h2>
          <p className="muted">Host: {roomState.hostUserId.slice(0, 8)}</p>

          <ul className="players">
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
              onClick={() => {
                const self = roomState.players.find((p) => p.userId === meUserId);
                apiRef.current?.setReady(!(self?.ready ?? false));
              }}
            >
              Toggle Ready
            </button>

            <button disabled={roomState.hostUserId !== meUserId || roomState.players.length < 2} onClick={() => apiRef.current?.startGame()}>
              Start Game
            </button>

            <button
              onClick={() => {
                leaveToHome();
              }}
            >
              Leave
            </button>

            <button disabled={!canCreateRoom} onClick={createFreshRoom}>
              New Room
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (!gameState) {
    return (
      <main className="app">
        <section className="panel">Waiting for game state...</section>
      </main>
    );
  }

  if (gameState.status === 'FINISHED') {
    const winner = gameState.players.find((p) => p.userId === gameState.winnerUserId);
    const isHost = roomState.hostUserId === meUserId;
    return (
      <main className="app">
        <section className="panel">
          <h2>Game Over</h2>
          <p>Winner: {winner?.displayName ?? gameState.winnerUserId}</p>
          <div className="row">
            {isHost ? <button onClick={() => apiRef.current?.stopGame()}>Return to Lobby</button> : null}
            <button
              onClick={() => {
                leaveToHome();
              }}
            >
              Back Home
            </button>
            <button disabled={!canCreateRoom} onClick={createFreshRoom}>
              New Room
            </button>
          </div>
        </section>
      </main>
    );
  }

  const currentChant = CHANT_ORDER[gameState.chantIndex]!;
  const isHost = roomState.hostUserId === meUserId;

  return (
    <main className="app game-layout">
      <section className="panel game-main">
        <h2>Room {roomState.roomCode}</h2>
        <p>Current turn seat: {gameState.currentTurnSeat}</p>
        <p>Chant word: {formatCard(currentChant)}</p>
        <p>Pile count: {gameState.pileCount}</p>
        <p>Last revealed: {formatCard(gameState.lastRevealed?.card)}</p>
        <p>Your hand size: {me?.handCount ?? 0}</p>
        <p>
          Time sync: RTT {Math.round(rttAvg)} ms, offset {Math.round(offsetAvg)} ms
        </p>
        <p className="muted">If some players do not slap, one non-slapper is assigned the pile loser.</p>

        {isActionWindow ? (
          <div className="actions">
            <p>Action card: {formatCard(gameState.slapWindow.actionCard)}</p>
            <div className="row">
              {gestureOptions.map((gesture) => (
                <button
                  key={gesture}
                  className={selectedGesture === gesture ? 'active' : ''}
                  onClick={() => setSelectedGesture(gesture)}
                >
                  {formatCard(gesture)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="row">
          <button
            disabled={!canFlip}
            onClick={() => {
              playFlipSound();
              apiRef.current?.flip();
            }}
          >
            FLIP
          </button>
          <button className="slap" disabled={!canSlap} onClick={submitSlap}>
            SLAP (Space)
          </button>
          {isHost ? <button onClick={() => apiRef.current?.stopGame()}>Stop Game</button> : null}
          <button onClick={leaveToHome}>Leave Room</button>
          <button disabled={!canCreateRoom} onClick={createFreshRoom}>
            New Room
          </button>
        </div>
      </section>

      <aside className="panel feed">
        <h3>Feed</h3>
        <ul>
          {feed.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      </aside>
    </main>
  );
};
