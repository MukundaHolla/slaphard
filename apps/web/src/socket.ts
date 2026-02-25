import { io, type Socket } from 'socket.io-client';
import {
  clientEventsSchemas,
  serverEventsSchemas,
  type ClientEventName,
  type Gesture,
  type ServerEventName,
  type ServerEventPayload,
} from '@slaphard/shared';
import { playCheerSound, playSadSound } from './audio';
import { useAppStore } from './store';

const serverUrl = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';

const parseServerPayload = <T extends ServerEventName>(
  event: T,
  payload: unknown,
): ServerEventPayload<T> | undefined => {
  const parsed = serverEventsSchemas[event].safeParse(payload);
  return parsed.success ? (parsed.data as ServerEventPayload<T>) : undefined;
};

export interface SocketApi {
  socket: Socket;
  createRoom: (displayName: string) => void;
  joinRoom: (roomCode: string, displayName: string, userId?: string) => void;
  leaveRoom: () => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  stopGame: () => void;
  flip: () => void;
  slap: (eventId: string, gesture?: Gesture) => void;
  ping: () => void;
}

const emitValidated = <T extends ClientEventName>(socket: Socket, event: T, payload: unknown): void => {
  const parsed = clientEventsSchemas[event].safeParse(payload);
  if (!parsed.success) {
    useAppStore.getState().pushFeed(`client validation failed for ${event}`);
    return;
  }
  socket.emit(event, parsed.data);
};

export const createSocketApi = (): SocketApi => {
  const socket = io(serverUrl, {
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    useAppStore.getState().setSocketStatus('connected');
    useAppStore.getState().pushFeed('connected');
  });

  socket.on('disconnect', () => {
    useAppStore.getState().setSocketStatus('disconnected');
    useAppStore.getState().pushFeed('disconnected');
  });

  socket.on('v1:room.state', (payload) => {
    const data = parseServerPayload('v1:room.state', payload);
    if (!data) {
      return;
    }
    useAppStore.getState().setRoomState(data.room, data.meUserId);
  });

  socket.on('v1:game.state', (payload) => {
    const data = parseServerPayload('v1:game.state', payload);
    if (!data) {
      return;
    }
    const store = useAppStore.getState();
    const previousVersion = store.gameState?.version;
    store.setGameState(data.snapshot);

    if (!data.snapshot.slapWindow.active || data.snapshot.slapWindow.resolved) {
      store.clearSlapSubmission();
    }

    if (previousVersion !== data.snapshot.version) {
      const slapState = data.snapshot.slapWindow.active && !data.snapshot.slapWindow.resolved ? 'open' : 'idle';
      store.pushFeed(
        `state v${data.snapshot.version}: turn=${data.snapshot.currentTurnSeat}, slap=${slapState}`,
      );
    }
  });

  socket.on('v1:game.slapWindowOpen', (payload) => {
    const data = parseServerPayload('v1:game.slapWindowOpen', payload);
    if (!data) {
      return;
    }
    useAppStore.getState().clearSlapSubmission();
    useAppStore
      .getState()
      .pushFeed(
        `slap window open (${data.reason}${data.actionCard ? `: ${data.actionCard.toLowerCase()}` : ''})`,
      );
  });

  socket.on('v1:game.slapResult', (payload) => {
    const data = parseServerPayload('v1:game.slapResult', payload);
    if (!data) {
      return;
    }
    const me = useAppStore.getState().meUserId;

    if (data.reason !== 'FIRST_VALID_SLAP_WIN' && data.reason !== 'NO_SLAPS') {
      if (me && me === data.loserUserId) {
        playSadSound();
      } else {
        playCheerSound();
      }
    }

    const place = me ? data.orderedUserIds.findIndex((id: string) => id === me) : -1;
    const placeText = place >= 0 ? `${place + 1}${place === 0 ? 'st' : place === 1 ? 'nd' : 'th'}` : 'none';
    useAppStore.getState().pushFeed(`slap result: you=${placeText}, loser=${data.loserUserId.slice(0, 6)}`);
    useAppStore.getState().clearSlapSubmission();
  });

  socket.on('v1:penalty', (payload) => {
    const data = parseServerPayload('v1:penalty', payload);
    if (!data) {
      return;
    }
    const me = useAppStore.getState().meUserId;
    const isIdlePenalty = data.type === 'TURN_TIMEOUT' || data.type === 'NO_SLAPS';
    if (!isIdlePenalty) {
      if (me && me === data.userId) {
        playSadSound();
      } else {
        playCheerSound();
      }
    }
    useAppStore.getState().pushFeed(`penalty: ${data.type} on ${data.userId.slice(0, 6)}`);
  });

  socket.on('v1:pong', (payload) => {
    const data = parseServerPayload('v1:pong', payload);
    if (!data) {
      return;
    }
    useAppStore.getState().updateTimeSync(data.serverTime, data.clientTimeEcho);
  });

  socket.on('v1:error', (payload) => {
    const data = parseServerPayload('v1:error', payload);
    if (!data) {
      return;
    }
    useAppStore.getState().pushFeed(`error ${data.code}: ${data.message}`);
  });

  return {
    socket,
    createRoom: (displayName: string) => emitValidated(socket, 'v1:room.create', { displayName }),
    joinRoom: (roomCode: string, displayName: string, userId?: string) =>
      emitValidated(socket, 'v1:room.join', { roomCode: roomCode.toUpperCase(), displayName, userId }),
    leaveRoom: () => emitValidated(socket, 'v1:room.leave', {}),
    setReady: (ready: boolean) => emitValidated(socket, 'v1:lobby.ready', { ready }),
    startGame: () => emitValidated(socket, 'v1:lobby.start', {}),
    stopGame: () => emitValidated(socket, 'v1:game.stop', {}),
    flip: () => {
      const seq = useAppStore.getState().nextClientSeq();
      emitValidated(socket, 'v1:game.flip', {
        clientSeq: seq,
        clientTime: Date.now(),
      });
    },
    slap: (eventId: string, gesture?: Gesture) => {
      const state = useAppStore.getState();
      const seq = state.nextClientSeq();
      emitValidated(socket, 'v1:game.slap', {
        eventId,
        gesture,
        clientSeq: seq,
        clientTime: Date.now(),
        offsetMs: state.timeSync.offsetAvg,
        rttMs: state.timeSync.rttAvg,
      });
      state.markSlapSubmitted(eventId);
    },
    ping: () => emitValidated(socket, 'v1:ping', { clientTime: Date.now() }),
  };
};
