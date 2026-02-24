import { create } from 'zustand';
import { PING_INTERVAL_IN_GAME_MS, PING_INTERVAL_LOBBY_MS, type Gesture } from '@slaphard/shared';
import type { RoomState, GameStateView } from '@slaphard/shared';

export type SocketStatus = 'disconnected' | 'connecting' | 'connected';

interface TimeSyncState {
  offsetAvg: number;
  rttAvg: number;
  jitter: number;
  pingIntervalMs: number;
}

interface UiState {
  roomCodeInput: string;
  selectedGesture: Gesture | undefined;
  submittedSlapEventId: string | undefined;
}

interface AppState {
  socketStatus: SocketStatus;
  meUserId: string | undefined;
  roomState: RoomState | undefined;
  gameState: GameStateView | undefined;
  displayName: string;
  persistedRoomCode: string | undefined;
  feed: string[];
  clientSeq: number;
  timeSync: TimeSyncState;
  ui: UiState;

  setSocketStatus: (status: SocketStatus) => void;
  setDisplayName: (displayName: string) => void;
  setRoomCodeInput: (code: string) => void;
  setRoomState: (room: RoomState, meUserId: string) => void;
  setGameState: (state: GameStateView) => void;
  setSelectedGesture: (gesture?: Gesture) => void;
  markSlapSubmitted: (eventId: string) => void;
  clearSlapSubmission: () => void;
  pushFeed: (message: string) => void;
  clearRoom: () => void;
  nextClientSeq: () => number;
  updateTimeSync: (serverTime: number, clientTimeEcho: number) => void;
}

const localDisplayNameKey = 'slaphard.displayName';
const localUserKey = 'slaphard.userId';
const localRoomCodeKey = 'slaphard.roomCode';

const average = (previous: number, next: number, alpha = 0.2): number =>
  previous === 0 ? next : previous * (1 - alpha) + next * alpha;

export const getPersistedIdentity = (): {
  userId: string | undefined;
  roomCode: string | undefined;
  displayName: string | undefined;
} => ({
  userId: localStorage.getItem(localUserKey) ?? undefined,
  roomCode: localStorage.getItem(localRoomCodeKey) ?? undefined,
  displayName: localStorage.getItem(localDisplayNameKey) ?? undefined,
});

export const persistIdentity = ({
  userId,
  roomCode,
  displayName,
}: {
  userId: string | undefined;
  roomCode: string | undefined;
  displayName: string | undefined;
}): void => {
  if (userId) {
    localStorage.setItem(localUserKey, userId);
  }
  if (roomCode) {
    localStorage.setItem(localRoomCodeKey, roomCode);
  }
  if (displayName) {
    localStorage.setItem(localDisplayNameKey, displayName);
  }
};

export const clearPersistedRoom = (): void => {
  localStorage.removeItem(localRoomCodeKey);
};

export const useAppStore = create<AppState>((set, get) => ({
  socketStatus: 'disconnected',
  meUserId: undefined,
  roomState: undefined,
  gameState: undefined,
  displayName: getPersistedIdentity().displayName ?? '',
  persistedRoomCode: getPersistedIdentity().roomCode,
  feed: [],
  clientSeq: 0,
  timeSync: {
    offsetAvg: 0,
    rttAvg: 0,
    jitter: 0,
    pingIntervalMs: PING_INTERVAL_LOBBY_MS,
  },
  ui: {
    roomCodeInput: '',
    selectedGesture: undefined,
    submittedSlapEventId: undefined,
  },

  setSocketStatus: (socketStatus) => set({ socketStatus }),

  setDisplayName: (displayName) => {
    persistIdentity({ displayName, roomCode: undefined, userId: undefined });
    set({ displayName });
  },

  setRoomCodeInput: (roomCodeInput) => set((state) => ({ ui: { ...state.ui, roomCodeInput } })),

  setRoomState: (roomState, meUserId) => {
    persistIdentity({ userId: meUserId, roomCode: roomState.roomCode, displayName: undefined });
    set((state) => ({
      roomState,
      meUserId,
      persistedRoomCode: roomState.roomCode,
      gameState: roomState.status === 'LOBBY' ? undefined : state.gameState,
    }));
  },

  setGameState: (gameState) => {
    const pingIntervalMs = gameState.status === 'IN_GAME' ? PING_INTERVAL_IN_GAME_MS : PING_INTERVAL_LOBBY_MS;
    set((state) => ({ gameState, timeSync: { ...state.timeSync, pingIntervalMs } }));
  },

  setSelectedGesture: (selectedGesture) => set((state) => ({ ui: { ...state.ui, selectedGesture } })),

  markSlapSubmitted: (eventId) => set((state) => ({ ui: { ...state.ui, submittedSlapEventId: eventId } })),

  clearSlapSubmission: () =>
    set((state) => ({ ui: { ...state.ui, submittedSlapEventId: undefined, selectedGesture: undefined } })),

  pushFeed: (message) =>
    set((state) => ({
      feed: [message, ...state.feed].slice(0, 24),
    })),

  clearRoom: () => {
    clearPersistedRoom();
    set({
      roomState: undefined,
      gameState: undefined,
      persistedRoomCode: undefined,
      ui: {
        roomCodeInput: '',
        selectedGesture: undefined,
        submittedSlapEventId: undefined,
      },
      feed: [],
    });
  },

  nextClientSeq: () => {
    const next = get().clientSeq + 1;
    set({ clientSeq: next });
    return next;
  },

  updateTimeSync: (serverTime, clientTimeEcho) => {
    const now = Date.now();
    const rtt = now - clientTimeEcho;
    const offset = serverTime - (clientTimeEcho + rtt / 2);
    const prev = get().timeSync;

    set({
      timeSync: {
        ...prev,
        rttAvg: average(prev.rttAvg, rtt),
        offsetAvg: average(prev.offsetAvg, offset),
        jitter: average(prev.jitter, Math.abs(rtt - prev.rttAvg)),
      },
    });
  },
}));
