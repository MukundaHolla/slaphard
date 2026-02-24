CREATE TABLE IF NOT EXISTS room_snapshots (
  id bigserial PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  transition_type text NOT NULL,
  version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_snapshots_room_created_desc
  ON room_snapshots(room_id, created_at DESC);
