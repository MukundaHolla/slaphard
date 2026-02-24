import { ROOM_TTL_SECONDS, type RoomState } from '@slaphard/shared';
import type Redis from 'ioredis';
import type { RoomStore } from './room-store';

const roomByIdKey = (roomId: string) => `room:${roomId}`;
const roomByCodeKey = (roomCode: string) => `room:code:${roomCode}`;
const roomByUserKey = (userId: string) => `user:${userId}:room`;

export class RedisRoomStore implements RoomStore {
  constructor(private readonly redis: Redis) {}

  async getRoomById(roomId: string): Promise<RoomState | null> {
    const json = await this.redis.get(roomByIdKey(roomId));
    return json ? (JSON.parse(json) as RoomState) : null;
  }

  async getRoomByCode(roomCode: string): Promise<RoomState | null> {
    const roomId = await this.redis.get(roomByCodeKey(roomCode));
    if (!roomId) {
      return null;
    }
    return this.getRoomById(roomId);
  }

  async saveRoom(room: RoomState): Promise<void> {
    const tx = this.redis.multi();
    tx.set(roomByIdKey(room.roomId), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
    tx.set(roomByCodeKey(room.roomCode), room.roomId, 'EX', ROOM_TTL_SECONDS);
    for (const player of room.players) {
      tx.set(roomByUserKey(player.userId), room.roomId, 'EX', ROOM_TTL_SECONDS);
    }
    await tx.exec();
  }

  async deleteRoom(roomId: string): Promise<void> {
    const room = await this.getRoomById(roomId);
    if (!room) {
      return;
    }

    const tx = this.redis.multi();
    tx.del(roomByIdKey(roomId));
    tx.del(roomByCodeKey(room.roomCode));
    for (const player of room.players) {
      tx.del(roomByUserKey(player.userId));
    }
    await tx.exec();
  }

  async setUserRoom(userId: string, roomId: string): Promise<void> {
    await this.redis.set(roomByUserKey(userId), roomId, 'EX', ROOM_TTL_SECONDS);
  }

  async getUserRoom(userId: string): Promise<string | null> {
    return this.redis.get(roomByUserKey(userId));
  }

  async clearUserRoom(userId: string): Promise<void> {
    await this.redis.del(roomByUserKey(userId));
  }
}
