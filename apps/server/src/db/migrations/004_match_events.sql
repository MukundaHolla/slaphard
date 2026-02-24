CREATE TABLE IF NOT EXISTS match_events (
  id bigserial PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_events_match_created
  ON match_events(match_id, created_at);
