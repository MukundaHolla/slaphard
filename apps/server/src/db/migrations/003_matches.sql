CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  winner_user_id uuid NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  summary jsonb NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_room_ended_desc
  ON matches(room_id, ended_at DESC);
