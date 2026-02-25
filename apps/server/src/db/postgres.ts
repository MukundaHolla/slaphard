import { MatchRepository } from './match-repository';
import { RoomRepository } from './room-repository';
import type { MatchEventType, MatchSummary, PersistenceRepository, RoomTransitionType } from './types';
import type { RoomState } from '@slaphard/shared';

export class PostgresPersistenceRepository implements PersistenceRepository {
  constructor(
    private readonly roomRepo: RoomRepository = new RoomRepository(),
    private readonly matchRepo: MatchRepository = new MatchRepository(),
  ) {}

  async upsertRoomMetadata(room: RoomState): Promise<void> {
    await this.roomRepo.upsertRoomMetadata(room);
  }

  async writeRoomSnapshot(room: RoomState, transitionType: RoomTransitionType): Promise<void> {
    await this.roomRepo.writeRoomSnapshot(room, transitionType);
  }

  async markRoomDeleted(roomId: string, deletedAt: Date): Promise<void> {
    await this.roomRepo.markRoomDeleted(roomId, deletedAt);
  }

  async startMatch(roomId: string, startedAt: Date): Promise<string> {
    return this.matchRepo.startMatch(roomId, startedAt);
  }

  async finishMatch(
    matchId: string,
    winnerUserId: string | null,
    summary: MatchSummary,
    endedAt: Date,
  ): Promise<void> {
    await this.matchRepo.finishMatch(matchId, winnerUserId, summary, endedAt);
  }

  async appendMatchEvent(matchId: string, eventType: MatchEventType, payload: unknown): Promise<void> {
    await this.matchRepo.appendMatchEvent(matchId, eventType, payload);
  }
}

export class NoopPersistenceRepository implements PersistenceRepository {
  async upsertRoomMetadata(room: RoomState): Promise<void> {
    void room;
  }
  async writeRoomSnapshot(room: RoomState, transitionType: RoomTransitionType): Promise<void> {
    void room;
    void transitionType;
  }
  async markRoomDeleted(roomId: string, deletedAt: Date): Promise<void> {
    void roomId;
    void deletedAt;
  }
  async startMatch(roomId: string, startedAt: Date): Promise<string> {
    void roomId;
    void startedAt;
    return 'noop';
  }
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
  }
  async appendMatchEvent(matchId: string, eventType: MatchEventType, payload: unknown): Promise<void> {
    void matchId;
    void eventType;
    void payload;
  }
}
