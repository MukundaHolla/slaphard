import type { Logger } from 'pino';
import type { Server, Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import type { MatchEventType, MatchSummary, PersistenceRepository, RoomTransitionType } from '../../src/db/types';
import { GameService } from '../../src/service/game-service';
import { InMemoryRoomStore } from '../../src/store/in-memory-room-store';
import type { RoomState } from '@slaphard/shared';

interface EmittedEvent {
  event: string;
  payload: unknown;
}

interface FakeSocket extends Socket {
  emitted: EmittedEvent[];
}

const createLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createIo = () => {
  const sockets = new Map<string, Socket>();
  const io = {
    to: vi.fn(() => ({
      emit: vi.fn(),
    })),
    sockets: {
      sockets,
    },
  } as unknown as Server;
  return { io, sockets };
};

const createNoopPersistenceRepo = (): PersistenceRepository => ({
  async upsertRoomMetadata(room: RoomState): Promise<void> {
    void room;
  },
  async writeRoomSnapshot(room: RoomState, transitionType: RoomTransitionType): Promise<void> {
    void room;
    void transitionType;
  },
  async markRoomDeleted(roomId: string, deletedAt: Date): Promise<void> {
    void roomId;
    void deletedAt;
  },
  async startMatch(roomId: string, startedAt: Date): Promise<string> {
    void roomId;
    void startedAt;
    return 'noop-match';
  },
  async finishMatch(
    matchId: string,
    winnerUserId: string | null,
    summary: MatchSummary,
    endedAt: Date,
  ): Promise<void> {
    void matchId;
    void winnerUserId;
    void summary;
    void endedAt;
  },
  async appendMatchEvent(matchId: string, eventType: MatchEventType, payload: unknown): Promise<void> {
    void matchId;
    void eventType;
    void payload;
  },
});

const createFakeSocket = (id: string): FakeSocket => {
  const emitted: EmittedEvent[] = [];
  return {
    id,
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    emitted,
  } as unknown as FakeSocket;
};

const latestRoomPayload = (socket: FakeSocket): { room: { roomId: string; roomCode: string } } => {
  const payload = [...socket.emitted].reverse().find((entry) => entry.event === 'v1:room.state')?.payload;
  if (!payload || typeof payload !== 'object') {
    throw new Error('missing room state payload');
  }
  return payload as { room: { roomId: string; roomCode: string } };
};

const setupGame = async () => {
  const { io, sockets } = createIo();
  const logger = createLogger();
  const store = new InMemoryRoomStore();
  const service = new GameService(io, store, createNoopPersistenceRepo(), logger);

  const host = createFakeSocket('host-socket');
  const guest = createFakeSocket('guest-socket');
  sockets.set(host.id, host);
  sockets.set(guest.id, guest);

  await service.createRoom(host, { displayName: 'Host' });
  const roomPayload = latestRoomPayload(host);
  const hostUserId = (
    host.emitted.find((entry) => entry.event === 'v1:room.state')?.payload as { meUserId: string } | undefined
  )?.meUserId;
  await service.joinRoom(guest, { roomCode: roomPayload.room.roomCode, displayName: 'Guest' });
  await service.startGame(host);

  const room = await store.getRoomById(roomPayload.room.roomId);
  if (room?.gameState && hostUserId) {
    const hostSeat = room.gameState.players.find((player) => player.userId === hostUserId)?.seatIndex;
    if (hostSeat !== undefined) {
      room.gameState.currentTurnSeat = hostSeat;
      await store.saveRoom(room);
    }
  }

  return { service, store, host, roomId: roomPayload.room.roomId };
};

describe('GameService timer/resync reliability', () => {
  it('ignores stale timer generation callbacks', async () => {
    const { service, store, roomId } = await setupGame();
    const before = await store.getRoomById(roomId);
    expect(before?.status).toBe('IN_GAME');

    const generation = ((service as unknown as { timerGenerationByRoomId: Map<string, number> })
      .timerGenerationByRoomId.get(roomId) ?? 0);
    await (service as unknown as { resolveTurnTimeout: (roomId: string, generation?: number) => Promise<void> })
      .resolveTurnTimeout(roomId, generation - 1);

    const after = await store.getRoomById(roomId);
    expect(after?.version).toBe(before?.version);
    (service as unknown as { clearTimers: (roomId: string) => void }).clearTimers(roomId);
  });

  it('resyncs room/game snapshot to socket after recoverable gameplay error', async () => {
    const { service, host, roomId } = await setupGame();
    await service.flip(host, { clientSeq: 1, clientTime: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 60));

    host.emitted.length = 0;
    let caught: unknown;
    try {
      await service.flip(host, { clientSeq: 2, clientTime: Date.now() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    service.handleFailure(host, caught);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const emittedNames = host.emitted.map((entry) => entry.event);
    expect(emittedNames).toContain('v1:error');
    expect(emittedNames).toContain('v1:room.state');
    expect(emittedNames).toContain('v1:game.state');
    (service as unknown as { clearTimers: (roomId: string) => void }).clearTimers(roomId);
  });
});
