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
  homeStep: 'identity' | 'roomAction';
  homeMode: 'create' | 'join';
  selectedGesture: Gesture | undefined;
  submittedSlapEventId: string | undefined;
  feedCollapsed: boolean;
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
  setHomeStep: (step: UiState['homeStep']) => void;
  setHomeMode: (mode: UiState['homeMode']) => void;
  setRoomState: (room: RoomState, meUserId: string) => void;
  setGameState: (state: GameStateView) => void;
  setSelectedGesture: (gesture?: Gesture) => void;
  markSlapSubmitted: (eventId: string) => void;
  clearSlapSubmission: () => void;
  setFeedCollapsed: (collapsed: boolean) => void;
  pushFeed: (message: string) => void;
  clearRoom: () => void;
  nextClientSeq: () => number;
  updateTimeSync: (serverTime: number, clientTimeEcho: number) => void;
}

const localDisplayNameKey = 'slaphard.displayName';
const localUserKey = 'slaphard.userId';
const localRoomCodeKey = 'slaphard.roomCode';
const localFeedCollapsedKey = 'slaphard.feedCollapsed';

const safeLocalStorageGet = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeLocalStorageSet = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore persistence failures (Safari private mode / storage restrictions).
  }
};

const safeLocalStorageRemove = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore persistence failures (Safari private mode / storage restrictions).
  }
};

const average = (previous: number, next: number, alpha = 0.2): number =>
  previous === 0 ? next : previous * (1 - alpha) + next * alpha;

export const getPersistedIdentity = (): {
  userId: string | undefined;
  roomCode: string | undefined;
  displayName: string | undefined;
} => ({
  userId: safeLocalStorageGet(localUserKey) ?? undefined,
  roomCode: safeLocalStorageGet(localRoomCodeKey) ?? undefined,
  displayName: safeLocalStorageGet(localDisplayNameKey) ?? undefined,
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
    safeLocalStorageSet(localUserKey, userId);
  }
  if (roomCode) {
    safeLocalStorageSet(localRoomCodeKey, roomCode);
  }
  if (displayName) {
    safeLocalStorageSet(localDisplayNameKey, displayName);
  }
};

export const clearPersistedRoom = (): void => {
  safeLocalStorageRemove(localRoomCodeKey);
};

const persistedFeedCollapsed = (): boolean => {
  const value = safeLocalStorageGet(localFeedCollapsedKey);
  if (value === null) {
    return true;
  }
  return value === 'true';
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
    homeStep: 'identity',
    homeMode: 'create',
    selectedGesture: undefined,
    submittedSlapEventId: undefined,
    feedCollapsed: persistedFeedCollapsed(),
  },

  setSocketStatus: (socketStatus) => set({ socketStatus }),

  setDisplayName: (displayName) => {
    persistIdentity({ displayName, roomCode: undefined, userId: undefined });
    set({ displayName });
  },

  setRoomCodeInput: (roomCodeInput) => set((state) => ({ ui: { ...state.ui, roomCodeInput } })),

  setHomeStep: (homeStep) => set((state) => ({ ui: { ...state.ui, homeStep } })),

  setHomeMode: (homeMode) => set((state) => ({ ui: { ...state.ui, homeMode } })),

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

  setFeedCollapsed: (feedCollapsed) => {
    safeLocalStorageSet(localFeedCollapsedKey, String(feedCollapsed));
    set((state) => ({ ui: { ...state.ui, feedCollapsed } }));
  },

  pushFeed: (message) =>
    set((state) => ({
      feed: [message, ...state.feed].slice(0, 24),
    })),

  clearRoom: () => {
    clearPersistedRoom();
    set((state) => ({
      roomState: undefined,
      gameState: undefined,
      persistedRoomCode: undefined,
      ui: {
        roomCodeInput: '',
        homeStep: 'identity',
        homeMode: 'create',
        selectedGesture: undefined,
        submittedSlapEventId: undefined,
        feedCollapsed: state.ui.feedCollapsed,
      },
      feed: [],
    }));
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
