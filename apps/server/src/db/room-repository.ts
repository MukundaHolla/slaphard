import type { RoomState } from '@slaphard/shared';
import type { PoolClient } from 'pg';
import { withDbClient } from './client';
import { sanitizeRoomSnapshot, type RoomTransitionType } from './types';

const upsertRoomSql = `
INSERT INTO rooms (id, room_code, status, host_user_id, version, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
ON CONFLICT (id)
DO UPDATE SET
  room_code = EXCLUDED.room_code,
  status = EXCLUDED.status,
  host_user_id = EXCLUDED.host_user_id,
  version = EXCLUDED.version,
  updated_at = EXCLUDED.updated_at,
  deleted_at = NULL;
`;

const insertSnapshotSql = `
INSERT INTO room_snapshots (room_id, transition_type, version, payload, created_at)
VALUES ($1, $2, $3, $4::jsonb, NOW());
`;

const markDeletedSql = `
UPDATE rooms
SET status = 'ABANDONED', deleted_at = $2
WHERE id = $1;
`;

export class RoomRepository {
  async upsertRoomMetadata(room: RoomState): Promise<void> {
    await withDbClient((client) => this.upsertRoomMetadataWithClient(client, room));
  }

  async upsertRoomMetadataWithClient(client: PoolClient, room: RoomState): Promise<void> {
    await client.query(upsertRoomSql, [
      room.roomId,
      room.roomCode,
      room.status,
      room.hostUserId,
      room.version,
      room.createdAt,
      room.updatedAt,
    ]);
  }

  async writeRoomSnapshot(room: RoomState, transitionType: RoomTransitionType): Promise<void> {
    await withDbClient((client) => this.writeRoomSnapshotWithClient(client, room, transitionType));
  }

  async writeRoomSnapshotWithClient(
    client: PoolClient,
    room: RoomState,
    transitionType: RoomTransitionType,
  ): Promise<void> {
    await this.upsertRoomMetadataWithClient(client, room);
    await client.query(insertSnapshotSql, [
      room.roomId,
      transitionType,
      room.version,
      JSON.stringify(sanitizeRoomSnapshot(room)),
    ]);
  }

  async markRoomDeleted(roomId: string, deletedAt: Date): Promise<void> {
    await withDbClient(async (client) => {
      await client.query(markDeletedSql, [roomId, deletedAt.toISOString()]);
    });
  }
}
