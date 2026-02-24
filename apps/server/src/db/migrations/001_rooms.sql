CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  room_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('LOBBY', 'IN_GAME', 'FINISHED', 'ABANDONED')),
  host_user_id uuid NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_room_code ON rooms(room_code);
CREATE INDEX IF NOT EXISTS idx_rooms_updated_at_desc ON rooms(updated_at DESC);
