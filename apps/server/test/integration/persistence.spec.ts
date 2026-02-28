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

const expectNoEvent = async <T>(socket: Socket, event: string, ms: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      reject(new Error(`unexpected ${event}: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
    socket.on(event, handler);
  });
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

    host.hand = ['TACO', 'CAT'];
    guest.hand = [];
    room.gameState.currentTurnSeat = host.seatIndex;
    room.gameState.chantIndex = 0;
    room.gameState.pile = [];
    room.gameState.pileCount = 0;
    room.gameState.config.slapWindowMs = 100;
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

  it('allows host to kick a non-ready player from lobby', async () => {
    const repo = new RecordingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const joinedState = once<{ room: RoomState; meUserId: string }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    const lobbyUpdateAfterJoin = once<{ room: RoomState }>(
      a,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode && payload.room.players.length === 2,
    );
    b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
    const joined = await joinedState;
    await lobbyUpdateAfterJoin;

    const kickedNotice = once<{ roomCode: string; byUserId: string }>(b, 'v1:room.kicked');
    const lobbyAfterKick = once<{ room: RoomState }>(
      a,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode && payload.room.players.length === 1,
    );

    a.emit('v1:lobby.kick', { userId: joined.meUserId });
    const kicked = await kickedNotice;
    const updated = await lobbyAfterKick;

    expect(kicked.roomCode).toBe(created.room.roomCode);
    expect(kicked.byUserId).toBe(created.meUserId);
    expect(updated.room.players).toHaveLength(1);
    expect(updated.room.players[0]?.userId).toBe(created.meUserId);

    const kickedClientError = once<{ code: string }>(b, 'v1:error');
    b.emit('v1:lobby.ready', { ready: true });
    const errorPayload = await kickedClientError;
    expect(errorPayload.code).toBe('ROOM_NOT_FOUND');
  });

  it('rejects host kick when target is ready', async () => {
    const repo = new RecordingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const joinedState = once<{ room: RoomState; meUserId: string }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    const lobbyUpdateAfterJoin = once<{ room: RoomState }>(
      a,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode && payload.room.players.length === 2,
    );
    b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
    const joined = await joinedState;
    await lobbyUpdateAfterJoin;

    const readyUpdate = once<{ room: RoomState }>(
      a,
      'v1:room.state',
      (payload) =>
        payload.room.players.some((player) => player.userId === joined.meUserId && player.ready),
    );
    b.emit('v1:lobby.ready', { ready: true });
    await readyUpdate;

    const errorPayload = once<{ code: string }>(a, 'v1:error');
    a.emit('v1:lobby.kick', { userId: joined.meUserId });
    const error = await errorPayload;
    expect(error.code).toBe('INVALID_TARGET');
  });

  it('rejects lobby kick when caller is not host', async () => {
    const repo = new RecordingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const joinedState = once<{ room: RoomState }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
    await joinedState;

    const errorPayload = once<{ code: string }>(b, 'v1:error');
    b.emit('v1:lobby.kick', { userId: created.meUserId });
    const error = await errorPayload;
    expect(error.code).toBe('NOT_HOST');
  });

  it('rejects host kicking self', async () => {
    const repo = new RecordingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    cleanups.push(async () => {
      a.disconnect();
    });

    await once(a, 'connect');
    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const errorPayload = once<{ code: string }>(a, 'v1:error');
    a.emit('v1:lobby.kick', { userId: created.meUserId });
    const error = await errorPayload;
    expect(error.code).toBe('INVALID_TARGET');
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

    host.hand = ['CAT', 'CHEESE'];
    guest.hand = ['PIZZA', 'GOAT'];
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

  it('opens SAME_CARD slap window for consecutive equal normal cards', async () => {
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
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom]);

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

    host.hand = ['GOAT', 'CAT'];
    guest.hand = ['GOAT', 'PIZZA'];
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

    const noWindowAfterFirstFlip = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean } } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.currentTurnSeat === guest.seatIndex && payload.snapshot.slapWindow.active === false,
    );
    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await noWindowAfterFirstFlip;

    const sameCardOpenA = once<{ reason: string }>(a, 'v1:game.slapWindowOpen', (payload) => payload.reason === 'SAME_CARD');
    const sameCardOpenB = once<{ reason: string }>(b, 'v1:game.slapWindowOpen', (payload) => payload.reason === 'SAME_CARD');
    const sameCardStateA = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean; reason?: string } } }>(
      a,
      'v1:game.state',
      (payload) =>
        payload.snapshot.currentTurnSeat === guest.seatIndex &&
        payload.snapshot.slapWindow.active &&
        payload.snapshot.slapWindow.reason === 'SAME_CARD',
    );
    const sameCardStateB = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean; reason?: string } } }>(
      b,
      'v1:game.state',
      (payload) =>
        payload.snapshot.currentTurnSeat === guest.seatIndex &&
        payload.snapshot.slapWindow.active &&
        payload.snapshot.slapWindow.reason === 'SAME_CARD',
    );

    b.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await Promise.all([sameCardOpenA, sameCardOpenB, sameCardStateA, sameCardStateB]);
  });

  it('keeps same-card window active until all players slap, blocking flip attempts', async () => {
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
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom]);

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

    host.hand = ['GOAT', 'CAT'];
    guest.hand = ['GOAT', 'PIZZA'];
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

    const noWindowAfterFirstFlip = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean } } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.currentTurnSeat === guest.seatIndex && payload.snapshot.slapWindow.active === false,
    );
    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await noWindowAfterFirstFlip;

    const sameCardOpen = once<{ reason: string }>(a, 'v1:game.slapWindowOpen', (payload) => payload.reason === 'SAME_CARD');
    b.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await sameCardOpen;
    await wait(80);

    await wait(200);
    await expectNoEvent<{ reason: string }>(a, 'v1:game.slapResult', 120);

    const blockedFlipError = once<{ code: string }>(
      a,
      'v1:error',
      (payload) => payload.code === 'SLAP_WINDOW_ACTIVE',
    );
    a.emit('v1:game.flip', { clientSeq: 2, clientTime: Date.now() });
    await blockedFlipError;

    await expectNoEvent<{ userId: string; type: string }>(a, 'v1:penalty', 250);

    const slapResult = once<{ loserUserId: string; orderedUserIds: string[]; reason: string }>(
      a,
      'v1:game.slapResult',
      (payload) => payload.reason === 'LAST_SLAPPER',
    );
    const stateAfterResolve = once<{ snapshot: { slapWindow: { active: boolean }; currentTurnSeat: number } }>(
      a,
      'v1:game.state',
      (payload) => !payload.snapshot.slapWindow.active,
    );

    const eventId = (await store.getRoomByCode(created.room.roomCode))?.gameState?.slapWindow.eventId;
    if (!eventId) {
      throw new Error('missing same-card event id');
    }

    b.emit('v1:game.slap', {
      eventId,
      clientSeq: 2,
      clientTime: 5000,
      offsetMs: 900,
      rttMs: 10,
    });
    a.emit('v1:game.slap', {
      eventId,
      clientSeq: 3,
      clientTime: 10,
      offsetMs: -800,
      rttMs: 10,
    });

    const resolved = await slapResult;
    expect(resolved.orderedUserIds).toEqual([joined.meUserId, created.meUserId]);
    expect(resolved.loserUserId).toBe(created.meUserId);
    const resolvedState = await stateAfterResolve;
    expect(resolvedState.snapshot.slapWindow.active).toBe(false);
  });

  it('for five-player action windows, keeps flip blocked until all players slap', async () => {
    const repo = new RecordingPersistenceRepo();
    const { store, url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });
    const c = ioClient(url, { transports: ['websocket'] });
    const d = ioClient(url, { transports: ['websocket'] });
    const e = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
      c.disconnect();
      d.disconnect();
      e.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect'), once(c, 'connect'), once(d, 'connect'), once(e, 'connect')]);

    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const joinAndCapture = async (socket: Socket, displayName: string) => {
      const roomState = once<{ room: RoomState; meUserId: string }>(
        socket,
        'v1:room.state',
        (payload) => payload.room.roomCode === created.room.roomCode,
      );
      socket.emit('v1:room.join', { roomCode: created.room.roomCode, displayName });
      return roomState;
    };

    const joinedB = await joinAndCapture(b, 'BB');
    const joinedC = await joinAndCapture(c, 'CC');
    const joinedD = await joinAndCapture(d, 'DD');
    const joinedE = await joinAndCapture(e, 'EE');

    const toInGame = [
      once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME'),
      once<{ room: RoomState }>(b, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME'),
      once<{ room: RoomState }>(c, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME'),
      once<{ room: RoomState }>(d, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME'),
      once<{ room: RoomState }>(e, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME'),
    ];
    a.emit('v1:lobby.start', {});
    await Promise.all(toInGame);

    const room = await store.getRoomByCode(created.room.roomCode);
    expect(room?.gameState).toBeTruthy();
    if (!room?.gameState) {
      throw new Error('missing game state');
    }

    const seatA = room.gameState.players.find((player) => player.userId === created.meUserId)?.seatIndex;
    const seatB = room.gameState.players.find((player) => player.userId === joinedB.meUserId)?.seatIndex;
    const seatC = room.gameState.players.find((player) => player.userId === joinedC.meUserId)?.seatIndex;
    const seatD = room.gameState.players.find((player) => player.userId === joinedD.meUserId)?.seatIndex;
    const seatE = room.gameState.players.find((player) => player.userId === joinedE.meUserId)?.seatIndex;
    if (
      seatA === undefined ||
      seatB === undefined ||
      seatC === undefined ||
      seatD === undefined ||
      seatE === undefined
    ) {
      throw new Error('missing seat assignment');
    }

    room.gameState.players[seatA]!.hand = ['GORILLA', 'CAT'];
    room.gameState.players[seatB]!.hand = ['TACO', 'PIZZA'];
    room.gameState.players[seatC]!.hand = ['CAT', 'GOAT'];
    room.gameState.players[seatD]!.hand = ['GOAT', 'CHEESE'];
    room.gameState.players[seatE]!.hand = ['CHEESE', 'PIZZA'];
    room.gameState.currentTurnSeat = seatA;
    room.gameState.chantIndex = 0;
    room.gameState.pile = [];
    room.gameState.pileCount = 0;
    room.gameState.config.actionSlapWindowMs = 120;
    room.gameState.slapWindow = {
      active: false,
      receivedSlapsCount: 0,
      attempts: [],
      resolved: false,
    };
    await store.saveRoom(room);

    const actionOpen = once<{ eventId: string; reason: string; actionCard?: string }>(
      a,
      'v1:game.slapWindowOpen',
      (payload) => payload.reason === 'ACTION' && payload.actionCard === 'GORILLA',
    );
    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    const open = await actionOpen;

    await wait(240);
    await expectNoEvent<{ reason: string }>(a, 'v1:game.slapResult', 200);
    await expectNoEvent<{ type: string }>(a, 'v1:penalty', 200);

    const blockedFlipError = once<{ code: string }>(b, 'v1:error', (payload) => payload.code === 'SLAP_WINDOW_ACTIVE');
    b.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await blockedFlipError;

    await wait(60);
    const slapResult = once<{ loserUserId: string; reason: string; orderedUserIds: string[] }>(
      a,
      'v1:game.slapResult',
      (payload) => payload.reason === 'LAST_SLAPPER',
    );
    const resolvedState = once<{ snapshot: { slapWindow: { active: boolean } } }>(
      a,
      'v1:game.state',
      (payload) => !payload.snapshot.slapWindow.active,
    );

    b.emit('v1:game.slap', {
      eventId: open.eventId,
      gesture: 'GORILLA',
      clientSeq: 2,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });
    c.emit('v1:game.slap', {
      eventId: open.eventId,
      gesture: 'GORILLA',
      clientSeq: 1,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });
    d.emit('v1:game.slap', {
      eventId: open.eventId,
      gesture: 'GORILLA',
      clientSeq: 1,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });
    e.emit('v1:game.slap', {
      eventId: open.eventId,
      gesture: 'GORILLA',
      clientSeq: 1,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });
    await wait(60);
    a.emit('v1:game.slap', {
      eventId: open.eventId,
      gesture: 'GORILLA',
      clientSeq: 2,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });

    const result = await slapResult;
    expect(result.loserUserId).toBe(created.meUserId);
    expect(result.orderedUserIds.length).toBe(5);
    const after = await resolvedState;
    expect(after.snapshot.slapWindow.active).toBe(false);
  });

  it('ignores duplicate late slap packet for just-resolved slap event', async () => {
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
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom]);

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

    host.hand = ['TACO', 'GOAT'];
    guest.hand = ['CAT', 'PIZZA'];
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

    const slapResult = once<{ eventId: string }>(
      a,
      'v1:game.slapResult',
      (payload) => payload.eventId === open.eventId,
    );

    a.emit('v1:game.slap', {
      eventId: open.eventId,
      clientSeq: 1,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });
    b.emit('v1:game.slap', {
      eventId: open.eventId,
      clientSeq: 1,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });

    await slapResult;

    a.emit('v1:game.slap', {
      eventId: open.eventId,
      clientSeq: 2,
      clientTime: Date.now(),
      offsetMs: 0,
      rttMs: 10,
    });

    await Promise.all([
      expectNoEvent<{ type: string }>(a, 'v1:penalty', 350),
      expectNoEvent<{ type: string }>(b, 'v1:penalty', 350),
    ]);
  });

  it('finishes game immediately when flipper reaches zero cards', async () => {
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
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom]);

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
    guest.hand = ['GOAT'];
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

    const finishedA = once<{ snapshot: { status: string; winnerUserId?: string } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'FINISHED',
    );
    const finishedB = once<{ snapshot: { status: string; winnerUserId?: string } }>(
      b,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'FINISHED',
    );
    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });

    const [stateA, stateB] = await Promise.all([finishedA, finishedB]);
    expect(stateA.snapshot.winnerUserId).toBe(created.meUserId);
    expect(stateB.snapshot.winnerUserId).toBe(created.meUserId);
  });

  it('allows any player to return a finished game to lobby', async () => {
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
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom]);

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
    guest.hand = ['GOAT'];
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

    const finishedA = once<{ snapshot: { status: string } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'FINISHED',
    );
    const finishedB = once<{ snapshot: { status: string } }>(
      b,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'FINISHED',
    );
    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await Promise.all([finishedA, finishedB]);

    const toLobbyA = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'LOBBY');
    const toLobbyB = once<{ room: RoomState }>(b, 'v1:room.state', (payload) => payload.room.status === 'LOBBY');
    b.emit('v1:game.stop', {});
    await Promise.all([toLobbyA, toLobbyB]);
  });

  it('reattaches reconnected player to active game and emits fresh room/game state', async () => {
    const repo = new RecordingPersistenceRepo();
    const { url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect')]);

    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const joinedState = once<{ room: RoomState; meUserId: string }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    const joined = await (async () => {
      b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
      return joinedState;
    })();

    const aInGameRoom = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    const bInGameRoom = once<{ room: RoomState }>(b, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGameRoom, bInGameRoom]);

    b.disconnect();

    const bReconnect = ioClient(url, { transports: ['websocket'] });
    cleanups.push(async () => {
      bReconnect.disconnect();
    });
    await once(bReconnect, 'connect');

    const rejoinRoomState = once<{ room: RoomState; meUserId: string }>(
      bReconnect,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    const rejoinGameState = once<{ snapshot: { status: string } }>(
      bReconnect,
      'v1:game.state',
      (payload) => payload.snapshot.status === 'IN_GAME',
    );
    bReconnect.emit('v1:room.join', {
      roomCode: created.room.roomCode,
      displayName: 'BB',
      userId: joined.meUserId,
    });

    const roomState = await rejoinRoomState;
    await rejoinGameState;
    expect(roomState.meUserId).toBe(joined.meUserId);
  });

  it('skips zero-card turn seat after flip in three-player flow', async () => {
    const repo = new RecordingPersistenceRepo();
    const { store, url } = await boot(repo);

    const a = ioClient(url, { transports: ['websocket'] });
    const b = ioClient(url, { transports: ['websocket'] });
    const c = ioClient(url, { transports: ['websocket'] });

    cleanups.push(async () => {
      a.disconnect();
      b.disconnect();
      c.disconnect();
    });

    await Promise.all([once(a, 'connect'), once(b, 'connect'), once(c, 'connect')]);

    const createdState = once<{ room: RoomState; meUserId: string }>(a, 'v1:room.state');
    a.emit('v1:room.create', { displayName: 'AA' });
    const created = await createdState;

    const joinedB = once<{ room: RoomState; meUserId: string }>(
      b,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    b.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'BB' });
    const bState = await joinedB;

    const joinedC = once<{ room: RoomState; meUserId: string }>(
      c,
      'v1:room.state',
      (payload) => payload.room.roomCode === created.room.roomCode,
    );
    c.emit('v1:room.join', { roomCode: created.room.roomCode, displayName: 'CC' });
    const cState = await joinedC;

    const aInGame = once<{ room: RoomState }>(a, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    const bInGame = once<{ room: RoomState }>(b, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    const cInGame = once<{ room: RoomState }>(c, 'v1:room.state', (payload) => payload.room.status === 'IN_GAME');
    a.emit('v1:lobby.start', {});
    await Promise.all([aInGame, bInGame, cInGame]);

    const room = await store.getRoomByCode(created.room.roomCode);
    expect(room?.gameState).toBeTruthy();
    if (!room?.gameState) {
      throw new Error('missing game state');
    }

    const seatA = room.gameState.players.find((player) => player.userId === created.meUserId)?.seatIndex;
    const seatB = room.gameState.players.find((player) => player.userId === bState.meUserId)?.seatIndex;
    const seatC = room.gameState.players.find((player) => player.userId === cState.meUserId)?.seatIndex;
    if (seatA === undefined || seatB === undefined || seatC === undefined) {
      throw new Error('missing seat assignment');
    }

    room.gameState.players[seatA]!.hand = ['CAT', 'PIZZA'];
    room.gameState.players[seatB]!.hand = [];
    room.gameState.players[seatC]!.hand = ['GOAT', 'CHEESE'];
    room.gameState.currentTurnSeat = seatA;
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

    const stateA = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean }; version: number } }>(
      a,
      'v1:game.state',
      (payload) => payload.snapshot.currentTurnSeat === seatC && payload.snapshot.slapWindow.active === false,
    );
    const stateB = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean }; version: number } }>(
      b,
      'v1:game.state',
      (payload) => payload.snapshot.currentTurnSeat === seatC && payload.snapshot.slapWindow.active === false,
    );
    const stateC = once<{ snapshot: { currentTurnSeat: number; slapWindow: { active: boolean }; version: number } }>(
      c,
      'v1:game.state',
      (payload) => payload.snapshot.currentTurnSeat === seatC && payload.snapshot.slapWindow.active === false,
    );

    a.emit('v1:game.flip', { clientSeq: 1, clientTime: Date.now() });
    await Promise.all([stateA, stateB, stateC]);
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
