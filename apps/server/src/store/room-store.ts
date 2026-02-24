import type { RoomState } from '@slaphard/shared';

export interface RoomStore {
  getRoomById(roomId: string): Promise<RoomState | null>;
  getRoomByCode(roomCode: string): Promise<RoomState | null>;
  saveRoom(room: RoomState): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  setUserRoom(userId: string, roomId: string): Promise<void>;
  getUserRoom(userId: string): Promise<string | null>;
  clearUserRoom(userId: string): Promise<void>;
}
