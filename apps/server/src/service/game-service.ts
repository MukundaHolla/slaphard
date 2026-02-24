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
import type { RoomStore } from '../store/room-store';

interface SocketContext {
  userId: string;
  roomId: string;
}

interface RoomTimers {
  turnTimer?: NodeJS.Timeout;
  slapTimer?: NodeJS.Timeout;
}

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
  private readonly lastInputAtBySocketId = new Map<string, number>();

  constructor(
    private readonly io: Server,
    private readonly roomStore: RoomStore,
    private readonly logger: Logger,
  ) {}

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
        await this.roomStore.deleteRoom(room.roomId);
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

  async startGame(socket: Socket): Promise<void> {
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

    await this.roomStore.saveRoom(room);
    await this.emitRoomState(room);
    await this.emitGameState(room);
    this.rescheduleTimers(room);
  }

  async flip(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:game.flip'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid flip payload');
    }
    if (this.isRateLimited(socket.id)) {
      throw new ServiceError('RATE_LIMITED', 'too many events');
    }

    const { room, userId } = await this.roomAndUserFromSocket(socket.id);
    if (!room.gameState || room.status !== 'IN_GAME') {
      throw new ServiceError('NOT_IN_GAME', 'room not in game');
    }

    const result = applyEvent(room.gameState, { type: 'FLIP', userId }, Date.now());
    await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
  }

  async stopGame(socket: Socket): Promise<void> {
    const { room, userId } = await this.roomAndUserFromSocket(socket.id);

    if (room.status === 'LOBBY') {
      throw new ServiceError('NOT_IN_GAME', 'room is already in lobby');
    }
    if (room.hostUserId !== userId) {
      throw new ServiceError('NOT_HOST', 'only host can stop the game');
    }

    room.status = 'LOBBY';
    room.gameState = undefined;
    room.players.forEach((player) => {
      player.ready = false;
    });
    room.updatedAt = Date.now();
    room.version += 1;

    await this.roomStore.saveRoom(room);
    this.clearTimers(room.roomId);
    await this.emitRoomState(room);
  }

  async slap(socket: Socket, payload: unknown): Promise<void> {
    const parsed = clientEventsSchemas['v1:game.slap'].safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError('INTERNAL_ERROR', 'invalid slap payload', parsed.error.issues);
    }
    if (this.isRateLimited(socket.id)) {
      throw new ServiceError('RATE_LIMITED', 'too many events');
    }

    const { room, userId } = await this.roomAndUserFromSocket(socket.id);
    if (!room.gameState || room.status !== 'IN_GAME') {
      throw new ServiceError('NOT_IN_GAME', 'room not in game');
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
        this.emitRoomBroadcast(room.roomId, 'v1:game.slapResult', {
          eventId: effect.eventId,
          orderedUserIds: effect.orderedUserIds,
          loserUserId: effect.loserUserId,
          reason: effect.reason,
        });
      }

      if (effect.type === 'PENALTY') {
        this.emitRoomBroadcast(room.roomId, 'v1:penalty', {
          userId: effect.userId,
          type: effect.penaltyType,
          pileTaken: effect.pileTaken,
        });
      }
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

  private async emitRoomState(room: RoomState): Promise<void> {
    const { gameState: _gameState, ...roomPublic } = room;

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

  private clearTimers(roomId: string): void {
    const timers = this.timersByRoomId.get(roomId);
    if (!timers) {
      return;
    }
    if (timers.turnTimer) {
      clearTimeout(timers.turnTimer);
    }
    if (timers.slapTimer) {
      clearTimeout(timers.slapTimer);
    }
    this.timersByRoomId.delete(roomId);
  }

  private rescheduleTimers(room: RoomState): void {
    this.clearTimers(room.roomId);

    if (room.status !== 'IN_GAME' || !room.gameState) {
      return;
    }

    const timers: RoomTimers = {};
    if (room.gameState.slapWindow.active && !room.gameState.slapWindow.resolved) {
      const deadline = room.gameState.slapWindow.deadlineServerTime ?? Date.now();
      const delay = Math.max(0, deadline - Date.now());
      timers.slapTimer = setTimeout(() => {
        void this.resolveSlapWindowTimeout(room.roomId);
      }, delay);
    } else {
      const timeoutMs = room.gameState.config.turnTimeoutMs;
      timers.turnTimer = setTimeout(() => {
        void this.resolveTurnTimeout(room.roomId);
      }, timeoutMs);
    }

    this.timersByRoomId.set(room.roomId, timers);
  }

  private async resolveSlapWindowTimeout(roomId: string): Promise<void> {
    const room = await this.roomStore.getRoomById(roomId);
    if (!room || !room.gameState || !room.gameState.slapWindow.active || room.status !== 'IN_GAME') {
      return;
    }

    const result = applyEvent(room.gameState, { type: 'RESOLVE_SLAP_WINDOW' }, Date.now());
    await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
  }

  private async resolveTurnTimeout(roomId: string): Promise<void> {
    const room = await this.roomStore.getRoomById(roomId);
    if (!room || !room.gameState || room.status !== 'IN_GAME') {
      return;
    }

    const result = applyEvent(room.gameState, { type: 'TURN_TIMEOUT' }, Date.now());
    await this.consumeEngineResult(room, result.state, result.effects, result.error?.code);
  }

  emitError(socket: Socket, code: ErrorCode, message: string, details?: unknown): void {
    this.emitValidated(socket, 'v1:error', { code, message, details });
  }

  handleFailure(socket: Socket, error: unknown): void {
    if (error instanceof ServiceError) {
      this.emitError(socket, error.code, error.message, error.details);
      return;
    }

    this.logger.error({ error }, 'unexpected game service failure');
    this.emitError(socket, 'INTERNAL_ERROR', 'unexpected server error');
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
