import type { RoomState } from '@slaphard/shared';

export type RoomTransitionType =
  | 'CREATE'
  | 'JOIN'
  | 'LEAVE'
  | 'START'
  | 'STOP'
  | 'FINISH'
  | 'DELETE';

export type MatchEventType = 'SLAP_RESULT' | 'PENALTY' | 'TIMEOUT' | 'WIN';

export interface MatchSummary {
  roomCode: string;
  reason: string;
  players: Array<{
    userId: string;
    displayName: string;
    seatIndex: number;
    handCount: number;
  }>;
}

export interface PersistenceRepository {
  upsertRoomMetadata(room: RoomState): Promise<void>;
  writeRoomSnapshot(room: RoomState, transitionType: RoomTransitionType): Promise<void>;
  markRoomDeleted(roomId: string, deletedAt: Date): Promise<void>;
  startMatch(roomId: string, startedAt: Date): Promise<string>;
  finishMatch(
    matchId: string,
    winnerUserId: string | null,
    summary: MatchSummary,
    endedAt: Date,
  ): Promise<void>;
  appendMatchEvent(matchId: string, eventType: MatchEventType, payload: unknown): Promise<void>;
}

export const sanitizeRoomSnapshot = (room: RoomState): Record<string, unknown> => ({
  roomId: room.roomId,
  roomCode: room.roomCode,
  status: room.status,
  hostUserId: room.hostUserId,
  version: room.version,
  players: room.players.map((player) => ({
    userId: player.userId,
    displayName: player.displayName,
    seatIndex: player.seatIndex,
    connected: player.connected,
    ready: player.ready,
  })),
  game: room.gameState
    ? {
        status: room.gameState.status,
        currentTurnSeat: room.gameState.currentTurnSeat,
        chantIndex: room.gameState.chantIndex,
        pileCount: room.gameState.pileCount,
        winnerUserId: room.gameState.winnerUserId,
      }
    : null,
  createdAt: room.createdAt,
  updatedAt: room.updatedAt,
});
