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
  async upsertRoomMetadata(_room: RoomState): Promise<void> {}
  async writeRoomSnapshot(_room: RoomState, _transitionType: RoomTransitionType): Promise<void> {}
  async markRoomDeleted(_roomId: string, _deletedAt: Date): Promise<void> {}
  async startMatch(_roomId: string, _startedAt: Date): Promise<string> {
    return 'noop';
  }
  async finishMatch(
    _matchId: string,
    _winnerUserId: string | null,
    _summary: MatchSummary,
    _endedAt: Date,
  ): Promise<void> {}
  async appendMatchEvent(_matchId: string, _eventType: MatchEventType, _payload: unknown): Promise<void> {}
}
