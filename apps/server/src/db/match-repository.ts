import { randomUUID } from 'crypto';
import { withDbClient } from './client';
import type { MatchEventType, MatchSummary } from './types';

const insertMatchSql = `
INSERT INTO matches (id, room_id, winner_user_id, started_at, ended_at, summary)
VALUES ($1, $2, NULL, $3, NULL, NULL);
`;

const finishMatchSql = `
UPDATE matches
SET winner_user_id = $2,
    ended_at = $3,
    summary = $4::jsonb
WHERE id = $1;
`;

const appendEventSql = `
INSERT INTO match_events (match_id, event_type, payload, created_at)
VALUES ($1, $2, $3::jsonb, NOW());
`;

export class MatchRepository {
  async startMatch(roomId: string, startedAt: Date): Promise<string> {
    const matchId = randomUUID();
    await withDbClient(async (client) => {
      await client.query(insertMatchSql, [matchId, roomId, startedAt.toISOString()]);
    });
    return matchId;
  }

  async finishMatch(
    matchId: string,
    winnerUserId: string | null,
    summary: MatchSummary,
    endedAt: Date,
  ): Promise<void> {
    await withDbClient(async (client) => {
      await client.query(finishMatchSql, [
        matchId,
        winnerUserId,
        endedAt.toISOString(),
        JSON.stringify(summary),
      ]);
    });
  }

  async appendMatchEvent(matchId: string, eventType: MatchEventType, payload: unknown): Promise<void> {
    await withDbClient(async (client) => {
      await client.query(appendEventSql, [matchId, eventType, JSON.stringify(payload)]);
    });
  }
}
