import { createServer } from 'http';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket } from 'socket.io-client';
import { attachSocketHandlers } from '../../src/socket';
import { GameService } from '../../src/service/game-service';
import { InMemoryRoomStore } from '../../src/store/in-memory-room-store';
import type { MatchEventType, MatchSummary, PersistenceRepository, RoomTransitionType } from '../../src/db/types';
import type { RoomState } from '@slaphard/shared';

class RecordingPersistenceRepo implements PersistenceRepository {
  roomTransitions: RoomTransitionType[] = [];
  startedMatches: Array<{ roomId: string }> = [];
  finishedMatches: Array<{ matchId: string; winnerUserId: string | null; summary: MatchSummary }> = [];
  events: Array<{ matchId: string; eventType: MatchEventType; payload: unknown }> = [];
  deletedRooms: string[] = [];
  private matchIdCounter = 1;

  async upsertRoomMetadata(_room: RoomState): Promise<void> {}

  async writeRoomSnapshot(_room: RoomState, transitionType: RoomTransitionType): Promise<void> {
    this.roomTransitions.push(transitionType);
  }

  async markRoomDeleted(roomId: string, _deletedAt: Date): Promise<void> {
    this.deletedRooms.push(roomId);
  }

  async startMatch(roomId: string): Promise<string> {
    const matchId = `m-${this.matchIdCounter++}`;
    this.startedMatches.push({ roomId });
    return matchId;
  }

  async finishMatch(
    matchId: string,
    winnerUserId: string | null,
    summary: MatchSummary,
  ): Promise<void> {
    this.finishedMatches.push({ matchId, winnerUserId, summary });
  }

  async appendMatchEvent(matchId: string, eventType: MatchEventType, payload: unknown): Promise<void> {
    this.events.push({ matchId, eventType, payload });
  }
}

class FailingPersistenceRepo extends RecordingPersistenceRepo {
  override async writeRoomSnapshot(_room: RoomState, _transitionType: RoomTransitionType): Promise<void> {
    throw new Error('snapshot fail');
  }

  override async startMatch(_roomId: string): Promise<string> {
    throw new Error('start match fail');
  }
}

const once = <T>(socket: Socket, event: string, predicate?: (payload: T) => boolean): Promise<T> =>
  new Promise((resolve) => {
    const handler = (payload: T) => {
      if (predicate && !predicate(payload)) {
        return;
      }
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('persistence integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  const boot = async (repo: PersistenceRepository) => {
    const httpServer = createServer();
    const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
    const store = new InMemoryRoomStore();
    const service = new GameService(io, store, repo, pino({ enabled: false }));
    attachSocketHandlers(io, service, pino({ enabled: false }));

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as { port: number }).port;

    cleanups.push(async () => {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    return { store, url: `http://127.0.0.1:${port}` };
  };

  it('writes room snapshots and match events across create/join/start/stop/finish', async () => {
    const repo = new RecordingPersistenceRepo();
    const { store, url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const aRoomState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await aRoomState;

    const bRoomState = once<{ room: RoomState; meUserId: string }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
    const joined = await bRoomState;

    const toInGame = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    a.emit('v1:lobby.start', {});
    await toInGame;

    const room = await store.getRoomByCode(created.room.roomCode);
    expect(room?.gameState).toBeTruthy();
    if (!room?.gameState) {
      throw new Error('missing game state');
    }

    const host = room.gameState.players.find((player) => player.userId === created.meUserId);
    const guest = room.gameState.players.find((player) => player.userId === joined.meUserId);
    if (!host || !guest) {
      throw new Error('players not found');
    }

    host.hand = ['TACO'];
    guest.hand = [];
    room.gameState.currentTurnSeat = host.seatIndex;
    room.gameState.chantIndex = 0;
    room.gameState.pile = [];
    room.gameState.pileCount = 0;
    room.gameState.slapWindow = {
      active: false,
      receivedSlapsCount: 0,
      attempts: [],
      resolved: false,
    };
    await store.saveRoom(room);

    const slapOpen = once<{ eventId: string }>(a, 'v1:game.slapWindowOpen');
    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    const open = await slapOpen;

    const slapResult = once<{
      eventId: string;
      orderedUserIds: string[];
      loserUserId: string;
      reason: string;
    }>(a, 'v1:game.slapResult');
    const finished = once<{ snapshot: { status: string } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'FINISHED',
    );
    b.emit('v1:game.slap', {
      eventId: open.eventId,
      clientSeq: 1,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
      gesture: 'GORILLA',
    });
    await slapResult;
    await finished;
    await wait(20);

    expect(repo.roomTransitions).toEqual(expect.arrayContaining(['CREATE', 'JOIN', 'START', 'FINISH']));
    expect(repo.startedMatches.length).toBe(1);
    expect(repo.finishedMatches.length).toBe(1);
    expect(repo.events.some((event) => event.eventType === 'SLAP_RESULT')).toBe(true);

    const toLobby = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'LOBBY');
    a.emit('v1:game.stop', {});
    await toLobby;

    expect(repo.roomTransitions).toContain('STOP');
  });

  it('keeps game flow alive when persistence fails', async () => {
    const repo = new FailingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    cleanups.push(async () => {
      a.disconnect();
    });

    await once(a, 'connect');
    const created = once<{ room: RoomState }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const roomState = await created;

    expect(roomState.room.status).toBe('LOBBY');
  });

  it('broadcasts first flip progression state to all players', async () => {
    const repo = new RecordingPersistenceRepo();
    const { store, url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const aRoomState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await aRoomState;

    const bRoomState = once<{ room: RoomState; meUserId: string }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
    const joined = await bRoomState;

    const aInGameRoom = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    const bInGameRoom = once<{ room: RoomState }>(b, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    const aInitialGame = once<{ snapshot: { status: string; version: number } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'IN_GAME',
    );
    const bInitialGame = once<{ snapshot: { status: string; version: number } }>(
      b,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'IN_GAME',
    );

    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom, aInitialGame, bInitialGame]);

    const room = await store.getRoomByCode(created.room.roomCode);
    expect(room?.gameState).toBeTruthy();
    if (!room?.gameState) {
      throw new Error('missing game state');
    }

    const host = room.gameState.players.find((player) => player.userId === created.meUserId);
    const guest = room.gameState.players.find((player) => player.userId === joined.meUserId);
    if (!host || !guest) {
      throw new Error('players not found');
    }

    host.hand = ['CAT'];
    guest.hand = ['PIZZA'];
    room.gameState.currentTurnSeat = host.seatIndex;
    room.gameState.chantIndex = 0;
    room.gameState.pile = [];
    room.gameState.pileCount = 0;
    room.gameState.slapWindow = {
      active: false,
      receivedSlapsCount: 0,
      attempts: [],
      resolved: false,
    };
    await store.saveRoom(room);

    const baselineVersion = room.gameState.version;
    const afterFlipA = once<{ snapshot: { status: string; version: number; currentTurnSeat: number; slapWindow: { active: boolean; resolved: boolean } } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.version > baselineVersion,
    );
    const afterFlipB = once<{ snapshot: { status: string; version: number; currentTurnSeat: number; slapWindow: { active: boolean; resolved: boolean } } }>(
      b,
      'v1:game.state',
      (payload) => payload.snapshot.version > baselineVersion,
    );

    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });

    const [stateA, stateB] = await Promise.all([afterFlipA, afterFlipB]);

    expect(stateA.snapshot.status).toBe('IN_GAME');
    expect(stateB.snapshot.status).toBe('IN_GAME');
    expect(stateA.snapshot.currentTurnSeat).toBe(guest.seatIndex);
    expect(stateB.snapshot.currentTurnSeat).toBe(guest.seatIndex);
    expect(stateA.snapshot.slapWindow.active).toBe(false);
    expect(stateB.snapshot.slapWindow.active).toBe(false);
  });

  it('closes active match when host stops an in-progress game', async () => {
    const repo = new RecordingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const created = once<{ room: RoomState }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const roomState = await created;

    const joined = once<{ room: RoomState }>(b, 'v1:room.state');
    b.emit('v1:room.join', { roomCode: roomState.room.roomCode, displayName: 'BB' });
    await joined;

    const inGame = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    a.emit('v1:lobby.start', {});
    await inGame;

    const backToLobby = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'LOBBY');
    a.emit('v1:game.stop', {});
    await backToLobby;

    expect(repo.startedMatches.length).toBe(1);
    expect(repo.finishedMatches.length).toBe(1);
    expect(repo.finishedMatches[0]?.summary.reason).toBe('GAME_STOPPED');
  });
});
