import { ROOM_TTL_SECONDS, type RoomState } from '@slaphard/shared';
import type { RoomStore } from './room-store';

interface Entry {
  room: RoomState;
  expiresAt: number;
}

export class InMemoryRoomStore implements RoomStore {
  private readonly roomsById = new Map<string, Entry>();
  private readonly roomIdByCode = new Map<string, string>();
  private readonly roomIdByUser = new Map<string, string>();

  private now() {
    return Date.now();
  }

  private ttlMs() {
    return ROOM_TTL_SECONDS * 1000;
  }

  private sweep(roomId: string): void {
    const entry = this.roomsById.get(roomId);
    if (!entry) {
      return;
    }

    if (entry.expiresAt > this.now()) {
      return;
    }

    this.roomsById.delete(roomId);
    this.roomIdByCode.delete(entry.room.roomCode);
    for (const player of entry.room.players) {
      this.roomIdByUser.delete(player.userId);
    }
  }

  async getRoomById(roomId: string): Promise<RoomState | null> {
    this.sweep(roomId);
    const entry = this.roomsById.get(roomId);
    return entry ? structuredClone(entry.room) : null;
  }

  async getRoomByCode(roomCode: string): Promise<RoomState | null> {
    const roomId = this.roomIdByCode.get(roomCode);
    if (!roomId) {
      return null;
    }
    return this.getRoomById(roomId);
  }

  async saveRoom(room: RoomState): Promise<void> {
    this.roomsById.set(room.roomId, {
      room: structuredClone(room),
      expiresAt: this.now() + this.ttlMs(),
    });
    this.roomIdByCode.set(room.roomCode, room.roomId);
    for (const player of room.players) {
      this.roomIdByUser.set(player.userId, room.roomId);
    }
  }

  async deleteRoom(roomId: string): Promise<void> {
    const entry = this.roomsById.get(roomId);
    if (!entry) {
      return;
    }
    this.roomsById.delete(roomId);
    this.roomIdByCode.delete(entry.room.roomCode);
    for (const player of entry.room.players) {
      this.roomIdByUser.delete(player.userId);
    }
  }

  async setUserRoom(userId: string, roomId: string): Promise<void> {
    this.roomIdByUser.set(userId, roomId);
  }

  async getUserRoom(userId: string): Promise<string | null> {
    return this.roomIdByUser.get(userId) ?? null;
  }

  async clearUserRoom(userId: string): Promise<void> {
    this.roomIdByUser.delete(userId);
  }
}
