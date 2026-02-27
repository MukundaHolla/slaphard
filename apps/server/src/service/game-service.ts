import { applyEvent, buildGameStateView, createInitialState } from '@slaphard/engine';
import {
  ACTION_CARDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  clientEventsSchemas,
  serverEventsSchemas,
  type ErrorCode,
  type RoomState,
} from '@slaphard/shared';
import type { EngineEffect, EngineEvent } from '@slaphard/engine';
import type { Logger } from 'pino';
import type { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import type { MatchEventType, MatchSummary, PersistenceRepository, RoomTransitionType } from '../db/types';
import type { RoomStore } from '../store/room-store';

interface SocketContext {
  userId: string;
  roomId: string;
}

interface RoomTimers {
  turnTimer?: NodeJS.Timeout;
  slapTimer?: NodeJS.Timeout;
  generation: number;
}

interface RecentResolvedSlap {
  eventId: string;
  resolvedAt: number;
  participantUserIds: Set<string>;
}

const RESOLVED_SLAP_DUPLICATE_GRACE_MS = 250;
const TIMER_NOOP_ERROR_CODES = new Set<ErrorCode>(['SLAP_WINDOW_ACTIVE', 'NO_SLAP_WINDOW', 'NOT_IN_GAME']);
const RECOVERABLE_RESYNC_ERROR_CODES = new Set<ErrorCode>([
  'NOT_YOUR_TURN',
  'SLAP_WINDOW_ACTIVE',
  'NO_SLAP_WINDOW',
  'INVALID_EVENT_ID',
  'ALREADY_SLAPPED',
]);

const randomCode = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const isGesture = (value: string | undefined): value is (typeof ACTION_CARDS)[number] =>
  !!value && (ACTION_CARDS as readonly string[]).includes(value);

export class GameService {
  private readonly socketContext = new Map<string, SocketContext>();
  private readonly socketsByUserId = new Map<string, Set<string>>();
  private readonly timersByRoomId = new Map<string, RoomTimers>();
  private readonly timerGenerationByRoomId = new Map<string, number>();
  private readonly lastInputAtBySocketId = new Map<string, number>();
  private readonly activeMatchByRoomId = new Map<string, string>();
  private readonly recentResolvedSlapByRoomId = new Map<string, RecentResolvedSlap>();
  private readonly roomMutationQueueByRoomId = new Map<string, Promise<void>>();

  constructor(
    private readonly io: Server,
    private readonly roomStore: RoomStore,
    private readonly persistenceRepo: PersistenceRepository,
    private readonly logger: Logger,
  ) {}

  private async withRoomMutationLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.roomMutationQueueByRoomId.get(roomId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.roomMutationQueueByRoomId.set(roomId, queued);

    await previous;
    try {
      return await task();
    } finally {
      release?.();
      if (this.roomMutationQueueByRoomId.get(roomId) === queued) {
        this.roomMutationQueueByRoomId.delete(roomId);
      }
    }
  }

  async createRoom(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:room.create'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INVALID_NAME', 'invalid display name', parsed.error.issues);
    }

    const now = Date.now();
    const userId = uuidv4();
    const roomCode = await this.allocateRoomCode();
    const roomId = uuidv4();

    const room: RoomState = {
      roomId,
      roomCode,
      status: 'LOBBY',
      hostUserId: userId,
      players: [
        {
          userId,
          displayName: parsed.data.displayName,
          seatIndex: 0,
          connected: true,
          ready: false,
        },
      ],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.roomStore.saveRoom(room);
    await this.persistRoomTransition(room, 'CREATE', { userId });
    await this.attachSocket(socket, room, userId);
    await this.emitRoomState(room);
  }

  async joinRoom(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:room.join'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INVALID_NAME', 'invalid join payload', parsed.error.issues);
    }

    const { roomCode, displayName, userId: candidateUserId } = parsed.data;
    const room = await this.roomStore.getRoomByCode(roomCode);
    if (!room) {
      throw new ServiceError('ROOM_NOT_FOUND', 'room does not exist');
    }

    const now = Date.now();
    let userId = candidateUserId;
    const existingSeat = candidateUserId
      ? room.players.findIndex((player) => player.userId === candidateUserId)
      : -1;

    if (existingSeat >= 0) {
      const player = room.players[existingSeat]!;
      player.connected = true;
      player.displayName = displayName;
      if (room.gameState) {
        const gamePlayer = room.gameState.players[existingSeat];
        if (gamePlayer) {
          gamePlayer.connected = true;
          gamePlayer.displayName = displayName;
        }
      }
    } else {
      if (room.status !== 'LOBBY') {
        throw new ServiceError('NOT_IN_LOBBY', 'cannot join as new player while game is active');
      }
      if (room.players.length >= MAX_PLAYERS) {
        throw new ServiceError('ROOM_FULL', 'room is full');
      }

      userId = uuidv4();
      room.players.push({
        userId,
        displayName,
        seatIndex: room.players.length,
        connected: true,
        ready: false,
      });
    }

    if (!userId) {
      throw new ServiceError('INTERNAL_ERROR', 'unable to assign user id');
    }

    room.updatedAt = now;
    room.version += 1;
    await this.roomStore.saveRoom(room);
    await this.persistRoomTransition(room, 'JOIN', { userId });
    await this.attachSocket(socket, room, userId);

    await this.emitRoomState(room);
    await this.emitGameState(room);
    this.rescheduleTimers(room);
  }

  async leaveRoom(socket: Socket): Promise<void> {
    const ctx = this.socketContext.get(socket.id);
    if (!ctx) {
      return;
    }

    const room = await this.roomStore.getRoomById(ctx.roomId);
    if (!room) {
      await this.detachSocket(socket.id, ctx.userId);
      return;
    }

    const playerIndex = room.players.findIndex((player) => player.userId === ctx.userId);
    if (playerIndex < 0) {
      await this.detachSocket(socket.id, ctx.userId);
      return;
    }

    await this.detachSocket(socket.id, ctx.userId);
    const stillConnected = (this.socketsByUserId.get(ctx.userId)?.size ?? 0) > 0;

    if (room.status === 'LOBBY') {
      if (!stillConnected) {
        room.players.splice(playerIndex, 1);
        await this.roomStore.clearUserRoom(ctx.userId);
        room.players.forEach((player, index) => {
          player.seatIndex = index;
        });
      }

      if (room.players.length === 0) {
        await this.persistRoomTransition(room, 'DELETE', { userId: ctx.userId });
        await this.persistWithRetry(
          async () => {
            await this.persistenceRepo.markRoomDeleted(room.roomId, new Date());
          },
          { roomId: room.roomId, userId: ctx.userId, action: 'markRoomDeleted' },
        );
        await this.roomStore.deleteRoom(room.roomId);
        this.activeMatchByRoomId.delete(room.roomId);
        this.recentResolvedSlapByRoomId.delete(room.roomId);
        this.clearTimers(room.roomId);
        return;
      }

      if (!room.players.some((player) => player.userId === room.hostUserId)) {
        room.hostUserId = room.players[0]!.userId;
      }
    } else {
      room.players[playerIndex]!.connected = stillConnected;
      if (room.gameState) {
        room.gameState.players[playerIndex]!.connected = stillConnected;
      }
    }

    room.updatedAt = Date.now();
    room.version += 1;
    await this.roomStore.saveRoom(room);
    await this.persistRoomTransition(room, 'LEAVE', { userId: ctx.userId });
    await this.emitRoomState(room);
    await this.emitGameState(room);
  }

  async setReady(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:lobby.ready'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid ready payload');
    }

    const { room, userId } = await this.roomAndUserFromSocket(socket.id);
    if (room.status !== 'LOBBY') {
      throw new ServiceError('NOT_IN_LOBBY', 'ready can only be changed in lobby');
    }

    const player = room.players.find((entry) => entry.userId === userId);
    if (!player) {
      throw new ServiceError('ROOM_NOT_FOUND', 'player not found in room');
    }

    player.ready = parsed.data.ready;
    room.updatedAt = Date.now();
    room.version += 1;
    await this.roomStore.saveRoom(room);
    await this.emitRoomState(room);
  }

  async kickFromLobby(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:lobby.kick'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid kick payload', parsed.error.issues);
    }

    const { room, userId } = await this.roomAndUserFromSocket(socket.id);
    if (room.status !== 'LOBBY') {
      throw new ServiceError('NOT_IN_LOBBY', 'kick can only be used in lobby');
    }
    if (room.hostUserId !== userId) {
      throw new ServiceError('NOT_HOST', 'only host can kick players');
    }

    const targetUserId = parsed.data.userId;
    const targetIndex = room.players.findIndex((entry) => entry.userId === targetUserId);
    if (targetIndex < 0) {
      throw new ServiceError('INVALID_TARGET', 'kick target is not in room');
    }

    const target = room.players[targetIndex]!;
    if (target.userId === userId || target.userId === room.hostUserId) {
      throw new ServiceError('INVALID_TARGET', 'host cannot kick this target');
    }
    if (target.ready) {
      throw new ServiceError('INVALID_TARGET', 'ready players cannot be kicked');
    }

    const targetSocketIds = [...(this.socketsByUserId.get(targetUserId) ?? [])];
    for (const socketId of targetSocketIds) {
      const targetSocket = this.io.sockets.sockets.get(socketId);
      if (targetSocket) {
        this.emitValidated(targetSocket, 'v1:room.kicked', {
          roomCode: room.roomCode,
          byUserId: userId,
        });
        targetSocket.leave(room.roomId);
      }
      await this.detachSocket(socketId, targetUserId);
    }

    await this.roomStore.clearUserRoom(targetUserId);
    room.players.splice(targetIndex, 1);
    room.players.forEach((player, index) => {
      player.seatIndex = index;
    });
    room.updatedAt = Date.now();
    room.version += 1;

    await this.roomStore.saveRoom(room);
    await this.persistRoomTransition(room, 'LEAVE', {
      userId: targetUserId,
      byUserId: userId,
      reason: 'HOST_KICK',
    });
    await this.emitRoomState(room);
  }

  async startGame(socket: Socket): Promise<void> {
    const ctx = this.socketContext.get(socket.id);
    if (!ctx) {
      throw new ServiceError('ROOM_NOT_FOUND', 'socket has no room context');
    }
    await this.withRoomMutationLock(ctx.roomId, async () => {
      const { room, userId } = await this.roomAndUserFromSocket(socket.id);

      if (room.status !== 'LOBBY') {
        throw new ServiceError('NOT_IN_LOBBY', 'room is not in lobby state');
      }
      if (room.hostUserId !== userId) {
        throw new ServiceError('NOT_HOST', 'only host can start game');
      }
      if (room.players.length < MIN_PLAYERS) {
        throw new ServiceError('NOT_IN_LOBBY', 'not enough players to start');
      }

      const now = Date.now();
      room.gameState = createInitialState({
        players: room.players.map((player) => ({
          userId: player.userId,
          displayName: player.displayName,
          connected: player.connected,
          ready: player.ready,
        })),
        nowServerTime: now,
        seed: `${room.roomId}:${room.version}:${now}`,
      });
      room.status = 'IN_GAME';
      room.updatedAt = now;
      room.version += 1;
      this.recentResolvedSlapByRoomId.delete(room.roomId);

      await this.roomStore.saveRoom(room);
      await this.persistRoomTransition(room, 'START', { userId });
      const matchId = await this.persistWithRetry(
        () => this.persistenceRepo.startMatch(room.roomId, new Date(now)),
        { roomId: room.roomId, userId, action: 'startMatch' },
      );
      if (matchId) {
        this.activeMatchByRoomId.set(room.roomId, matchId);
      }
      await this.emitRoomState(room);
      await this.emitGameState(room);
      this.rescheduleTimers(room);
    });
  }

  async flip(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:game.flip'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid flip payload');
    }
    if (this.isRateLimited(socket.id)) {
      throw new ServiceError('RATE_LIMITED', 'too many events');
    }

    const ctx = this.socketContext.get(socket.id);
    if (!ctx) {
      throw new ServiceError('ROOM_NOT_FOUND', 'socket has no room context');
    }
    await this.withRoomMutationLock(ctx.roomId, async () => {
      const { room, userId } = await this.roomAndUserFromSocket(socket.id);
      if (!room.gameState || room.status !== 'IN_GAME') {
        throw new ServiceError('NOT_IN_GAME', 'room not in game');
      }

      const result = applyEvent(room.gameState, { type: 'FLIP', userId }, Date.now());
      await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
    });
  }

  async stopGame(socket: Socket): Promise<void> {
    const ctx = this.socketContext.get(socket.id);
    if (!ctx) {
      throw new ServiceError('ROOM_NOT_FOUND', 'socket has no room context');
    }
    await this.withRoomMutationLock(ctx.roomId, async () => {
      const { room, userId } = await this.roomAndUserFromSocket(socket.id);

      if (room.status === 'LOBBY') {
        throw new ServiceError('NOT_IN_GAME', 'room is already in lobby');
      }
      if (room.status === 'IN_GAME' && room.hostUserId !== userId) {
        throw new ServiceError('NOT_HOST', 'only host can stop the game');
      }

      if (room.status === 'IN_GAME') {
        await this.finishPersistedMatch(room, 'GAME_STOPPED');
      }

      room.status = 'LOBBY';
      room.gameState = undefined;
      room.players.forEach((player) => {
        player.ready = false;
      });
      room.updatedAt = Date.now();
      room.version += 1;

      await this.roomStore.saveRoom(room);
      await this.persistRoomTransition(room, 'STOP', { userId });
      this.recentResolvedSlapByRoomId.delete(room.roomId);
      this.clearTimers(room.roomId);
      await this.emitRoomState(room);
    });
  }

  async slap(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:game.slap'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid slap payload', parsed.error.issues);
    }
    if (this.isRateLimited(socket.id)) {
      throw new ServiceError('RATE_LIMITED', 'too many events');
    }

    const ctx = this.socketContext.get(socket.id);
    if (!ctx) {
      throw new ServiceError('ROOM_NOT_FOUND', 'socket has no room context');
    }
    await this.withRoomMutationLock(ctx.roomId, async () => {
      const { room, userId } = await this.roomAndUserFromSocket(socket.id);
      if (!room.gameState || room.status !== 'IN_GAME') {
        throw new ServiceError('NOT_IN_GAME', 'room not in game');
      }
      const recentResolvedSlap = this.recentResolvedSlapByRoomId.get(room.roomId);
      if (
        recentResolvedSlap &&
        recentResolvedSlap.eventId === parsed.data.eventId &&
        Date.now() - recentResolvedSlap.resolvedAt <= RESOLVED_SLAP_DUPLICATE_GRACE_MS &&
        recentResolvedSlap.participantUserIds.has(userId)
      ) {
        return;
      }

      const event: EngineEvent = {
        type: 'SLAP',
        userId,
        eventId: parsed.data.eventId,
        clientSeq: parsed.data.clientSeq,
        clientTime: parsed.data.clientTime,
        offsetMs: parsed.data.offsetMs,
        rttMs: parsed.data.rttMs,
        ...(isGesture(parsed.data.gesture) ? { gesture: parsed.data.gesture } : {}),
      };

      const result = applyEvent(room.gameState, event, Date.now());
      await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
    });
  }

  async ping(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:ping'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid ping payload');
    }

    this.emitValidated(socket, 'v1:pong', {
      serverTime: Date.now(),
      clientTimeEcho: parsed.data.clientTime,
    });
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const ctx = this.socketContext.get(socket.id);
    if (!ctx) {
      return;
    }

    await this.detachSocket(socket.id, ctx.userId);
    const room = await this.roomStore.getRoomById(ctx.roomId);
    if (!room) {
      return;
    }

    const player = room.players.find((entry) => entry.userId === ctx.userId);
    if (!player) {
      return;
    }

    const stillConnected = (this.socketsByUserId.get(ctx.userId)?.size ?? 0) > 0;
    if (stillConnected) {
      return;
    }

    player.connected = false;
    if (room.gameState) {
      const gamePlayer = room.gameState.players.find((entry) => entry.userId === ctx.userId);
      if (gamePlayer) {
        gamePlayer.connected = false;
      }
    }

    room.updatedAt = Date.now();
    room.version += 1;
    await this.roomStore.saveRoom(room);
    if (room.status === 'IN_GAME') {
      await this.persistRoomTransition(room, 'LEAVE', { userId: ctx.userId });
    }
    await this.emitRoomState(room);
    await this.emitGameState(room);
  }

  private async consumeEngineResult(
    room: RoomState,
    nextState: RoomState['gameState'],
    effects: EngineEffect[],
    errorCode?: ErrorCode,
  ): Promise<void> {
    if (errorCode === 'ALREADY_SLAPPED') {
      return;
    }
    if (errorCode) {
      throw new ServiceError(errorCode, `engine rejected event (${errorCode})`);
    }

    if (!nextState) {
      throw new ServiceError('INTERNAL_ERROR', 'missing game state');
    }

    room.gameState = nextState;
    if (nextState.status === 'FINISHED') {
      room.status = 'FINISHED';
    }
    room.updatedAt = Date.now();
    room.version += 1;

    await this.roomStore.saveRoom(room);

    for (const effect of effects) {
      if (effect.type === 'SLAP_WINDOW_OPEN') {
        this.emitRoomBroadcast(room.roomId, 'v1:game.slapWindowOpen', {
          eventId: effect.eventId,
          reason: effect.reason,
          actionCard: effect.actionCard,
          startServerTime: effect.startServerTime,
          deadlineServerTime: effect.deadlineServerTime,
          slapWindowMs: effect.slapWindowMs,
        });
      }

      if (effect.type === 'SLAP_RESULT') {
        this.recentResolvedSlapByRoomId.set(room.roomId, {
          eventId: effect.eventId,
          resolvedAt: Date.now(),
          participantUserIds: new Set([...effect.orderedUserIds, effect.loserUserId]),
        });
        await this.appendMatchEvent(room.roomId, 'SLAP_RESULT', effect);
        this.emitRoomBroadcast(room.roomId, 'v1:game.slapResult', {
          eventId: effect.eventId,
          orderedUserIds: effect.orderedUserIds,
          loserUserId: effect.loserUserId,
          reason: effect.reason,
        });
      }

      if (effect.type === 'PENALTY') {
        await this.appendMatchEvent(
          room.roomId,
          effect.penaltyType === 'TURN_TIMEOUT' ? 'TIMEOUT' : 'PENALTY',
          effect,
        );
        this.emitRoomBroadcast(room.roomId, 'v1:penalty', {
          userId: effect.userId,
          type: effect.penaltyType,
          pileTaken: effect.pileTaken,
        });
      }
    }

    if (room.status === 'FINISHED') {
      await this.persistRoomTransition(room, 'FINISH');
      await this.appendMatchEvent(room.roomId, 'WIN', {
        winnerUserId: room.gameState?.winnerUserId ?? null,
      });
      await this.finishPersistedMatch(room, 'GAME_FINISHED');
    }

    await this.emitGameState(room);
    this.rescheduleTimers(room);
  }

  private async roomAndUserFromSocket(socketId: string): Promise<{ room: RoomState; userId: string }> {
    const ctx = this.socketContext.get(socketId);
    if (!ctx) {
      throw new ServiceError('ROOM_NOT_FOUND', 'socket has no room context');
    }

    const room = await this.roomStore.getRoomById(ctx.roomId);
    if (!room) {
      throw new ServiceError('ROOM_NOT_FOUND', 'room not found');
    }

    return { room, userId: ctx.userId };
  }

  private async allocateRoomCode(): Promise<string> {
    for (let i = 0; i < 20; i += 1) {
      const code = randomCode();
      const room = await this.roomStore.getRoomByCode(code);
      if (!room) {
        return code;
      }
    }

    throw new ServiceError('INTERNAL_ERROR', 'unable to allocate room code');
  }

  private async attachSocket(socket: Socket, room: RoomState, userId: string): Promise<void> {
    const previous = this.socketContext.get(socket.id);
    if (previous) {
      socket.leave(previous.roomId);
    }
    socket.join(room.roomId);
    this.socketContext.set(socket.id, { roomId: room.roomId, userId });

    const sockets = this.socketsByUserId.get(userId) ?? new Set<string>();
    sockets.add(socket.id);
    this.socketsByUserId.set(userId, sockets);

    await this.roomStore.setUserRoom(userId, room.roomId);
  }

  private async detachSocket(socketId: string, userId: string): Promise<void> {
    this.socketContext.delete(socketId);
    this.lastInputAtBySocketId.delete(socketId);

    const sockets = this.socketsByUserId.get(userId);
    if (!sockets) {
      return;
    }
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.socketsByUserId.delete(userId);
    }
  }

  private emitValidated(socket: Socket, eventName: keyof typeof serverEventsSchemas, payload: unknown): void {
    const schema = serverEventsSchemas[eventName];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.error({ eventName, errors: parsed.error.issues }, 'server payload schema failure');
      return;
    }
    socket.emit(eventName, parsed.data);
  }

  private emitRoomBroadcast(roomId: string, eventName: keyof typeof serverEventsSchemas, payload: unknown): void {
    const schema = serverEventsSchemas[eventName];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.error({ eventName, errors: parsed.error.issues }, 'server payload schema failure');
      return;
    }
    this.io.to(roomId).emit(eventName, parsed.data);
  }

  private buildRoomPublic(room: RoomState) {
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      status: room.status,
      hostUserId: room.hostUserId,
      players: room.players,
      version: room.version,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  private async emitRoomState(room: RoomState): Promise<void> {
    const roomPublic = this.buildRoomPublic(room);

    for (const player of room.players) {
      const socketIds = this.socketsByUserId.get(player.userId);
      if (!socketIds) {
        continue;
      }

      for (const socketId of socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (!socket) {
          continue;
        }
        this.emitValidated(socket, 'v1:room.state', {
          room: roomPublic,
          meUserId: player.userId,
        });
      }
    }
  }

  private async emitStateToSocketIfInRoom(socketId: string): Promise<void> {
    const ctx = this.socketContext.get(socketId);
    if (!ctx) {
      return;
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }
    const room = await this.roomStore.getRoomById(ctx.roomId);
    if (!room) {
      return;
    }
    const player = room.players.find((entry) => entry.userId === ctx.userId);
    if (!player) {
      return;
    }

    this.emitValidated(socket, 'v1:room.state', {
      room: this.buildRoomPublic(room),
      meUserId: player.userId,
    });

    if (!room.gameState) {
      return;
    }

    const snapshot = buildGameStateView(room.gameState, player.userId);
    this.emitValidated(socket, 'v1:game.state', {
      snapshot,
      serverTime: Date.now(),
      version: room.gameState.version,
    });
  }

  private async emitGameState(room: RoomState): Promise<void> {
    if (!room.gameState) {
      return;
    }

    for (const player of room.players) {
      const socketIds = this.socketsByUserId.get(player.userId);
      if (!socketIds) {
        continue;
      }

      const snapshot = buildGameStateView(room.gameState, player.userId);

      for (const socketId of socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (!socket) {
          continue;
        }
        this.emitValidated(socket, 'v1:game.state', {
          snapshot,
          serverTime: Date.now(),
          version: room.gameState.version,
        });
      }
    }
  }

  private clearTimers(roomId: string, clearGeneration = true): void {
    const timers = this.timersByRoomId.get(roomId);
    if (!timers) {
      if (clearGeneration) {
        this.timerGenerationByRoomId.delete(roomId);
      }
      return;
    }
    if (timers.turnTimer) {
      clearTimeout(timers.turnTimer);
    }
    if (timers.slapTimer) {
      clearTimeout(timers.slapTimer);
    }
    this.timersByRoomId.delete(roomId);
    if (clearGeneration) {
      this.timerGenerationByRoomId.delete(roomId);
    }
  }

  private rescheduleTimers(room: RoomState): void {
    const generation = (this.timerGenerationByRoomId.get(room.roomId) ?? 0) + 1;
    this.clearTimers(room.roomId, false);
    this.timerGenerationByRoomId.set(room.roomId, generation);

    if (room.status !== 'IN_GAME' || !room.gameState) {
      return;
    }

    const timers: RoomTimers = { generation };
    if (room.gameState.slapWindow.active && !room.gameState.slapWindow.resolved) {
      const requireAllSlapsBeforeResolve =
        room.gameState.slapWindow.reason === 'SAME_CARD' ||
        (room.gameState.slapWindow.reason === 'ACTION' && room.gameState.players.length >= 5);
      if (requireAllSlapsBeforeResolve) {
        this.timersByRoomId.set(room.roomId, timers);
        return;
      }
      const deadline = room.gameState.slapWindow.deadlineServerTime ?? Date.now();
      const delay = Math.max(0, deadline - Date.now());
      timers.slapTimer = setTimeout(() => {
        void this.resolveSlapWindowTimeout(room.roomId, generation).catch((error: unknown) => {
          this.logger.error({ roomId: room.roomId, generation, error }, 'slap timer callback failed');
        });
      }, delay);
    } else {
      const timeoutMs = room.gameState.config.turnTimeoutMs;
      timers.turnTimer = setTimeout(() => {
        void this.resolveTurnTimeout(room.roomId, generation).catch((error: unknown) => {
          this.logger.error({ roomId: room.roomId, generation, error }, 'turn timer callback failed');
        });
      }, timeoutMs);
    }

    this.timersByRoomId.set(room.roomId, timers);
  }

  private async resolveSlapWindowTimeout(roomId: string, generation?: number): Promise<void> {
    if (generation !== undefined && this.timerGenerationByRoomId.get(roomId) !== generation) {
      return;
    }
    await this.withRoomMutationLock(roomId, async () => {
      if (generation !== undefined && this.timerGenerationByRoomId.get(roomId) !== generation) {
        return;
      }
      const room = await this.roomStore.getRoomById(roomId);
      if (!room || !room.gameState || !room.gameState.slapWindow.active || room.status !== 'IN_GAME') {
        return;
      }
      const requireAllSlapsBeforeResolve =
        room.gameState.slapWindow.reason === 'SAME_CARD' ||
        (room.gameState.slapWindow.reason === 'ACTION' && room.gameState.players.length >= 5);
      if (requireAllSlapsBeforeResolve) {
        return;
      }

      const result = applyEvent(room.gameState, { type: 'RESOLVE_SLAP_WINDOW' }, Date.now());
      if (result.error?.code && TIMER_NOOP_ERROR_CODES.has(result.error.code)) {
        return;
      }
      await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
    });
  }

  private async resolveTurnTimeout(roomId: string, generation?: number): Promise<void> {
    if (generation !== undefined && this.timerGenerationByRoomId.get(roomId) !== generation) {
      return;
    }
    await this.withRoomMutationLock(roomId, async () => {
      if (generation !== undefined && this.timerGenerationByRoomId.get(roomId) !== generation) {
        return;
      }
      const room = await this.roomStore.getRoomById(roomId);
      if (!room || !room.gameState || room.status !== 'IN_GAME') {
        return;
      }

      const result = applyEvent(room.gameState, { type: 'TURN_TIMEOUT' }, Date.now());
      if (result.error?.code && TIMER_NOOP_ERROR_CODES.has(result.error.code)) {
        return;
      }
      await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
    });
  }

  emitError(socket: Socket, code: ErrorCode, message: string, details?: unknown): void {
    this.emitValidated(socket, 'v1:error', { code, message, details });
  }

  handleFailure(socket: Socket, error: unknown): void {
    if (error instanceof ServiceError) {
      this.emitError(socket, error.code, error.message, error.details);
      if (RECOVERABLE_RESYNC_ERROR_CODES.has(error.code)) {
        void this.emitStateToSocketIfInRoom(socket.id).catch((resyncError: unknown) => {
          this.logger.warn({ socketId: socket.id, errorCode: error.code, error: resyncError }, 'socket resync failed');
        });
      }
      return;
    }

    this.logger.error({ error }, 'unexpected game service failure');
    this.emitError(socket, 'INTERNAL_ERROR', 'unexpected server error');
  }

  private buildMatchSummary(room: RoomState, reason: string): MatchSummary {
    return {
      roomCode: room.roomCode,
      reason,
      players: (room.gameState?.players ?? []).map((player) => ({
        userId: player.userId,
        displayName: player.displayName,
        seatIndex: player.seatIndex,
        handCount: player.hand.length,
      })),
    };
  }

  private async finishPersistedMatch(room: RoomState, reason: string): Promise<void> {
    const matchId = this.activeMatchByRoomId.get(room.roomId);
    if (!matchId) {
      return;
    }

    await this.persistWithRetry(
      async () => {
        await this.persistenceRepo.finishMatch(
          matchId,
          room.gameState?.winnerUserId ?? null,
          this.buildMatchSummary(room, reason),
          new Date(),
        );
      },
      { roomId: room.roomId, action: 'finishMatch' },
    );

    this.activeMatchByRoomId.delete(room.roomId);
  }

  private async appendMatchEvent(roomId: string, eventType: MatchEventType, payload: unknown): Promise<void> {
    const matchId = this.activeMatchByRoomId.get(roomId);
    if (!matchId) {
      return;
    }

    await this.persistWithRetry(
      async () => {
        await this.persistenceRepo.appendMatchEvent(matchId, eventType, payload);
      },
      { roomId, matchId, action: 'appendMatchEvent', eventType },
    );
  }

  private async persistRoomTransition(
    room: RoomState,
    transitionType: RoomTransitionType,
    extraContext?: Record<string, unknown>,
  ): Promise<void> {
    await this.persistWithRetry(
      async () => {
        await this.persistenceRepo.writeRoomSnapshot(room, transitionType);
      },
      { roomId: room.roomId, transitionType, ...extraContext, action: 'writeRoomSnapshot' },
    );
  }

  private async persistWithRetry<T>(
    fn: () => Promise<T>,
    context: Record<string, unknown>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (firstError) {
      this.logger.warn({ ...context, error: firstError }, 'persistence failed, retrying once');
      try {
        return await fn();
      } catch (secondError) {
        this.logger.error({ ...context, error: secondError }, 'persistence failed after retry');
        return undefined;
      }
    }
  }

  private isRateLimited(socketId: string, minGapMs = 40): boolean {
    const now = Date.now();
    const previous = this.lastInputAtBySocketId.get(socketId) ?? 0;
    if (now - previous < minGapMs) {
      return true;
    }
    this.lastInputAtBySocketId.set(socketId, now);
    return false;
  }
}
