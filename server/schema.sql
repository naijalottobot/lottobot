/* LOTTO schema — auto-applied on boot (CREATE IF NOT EXISTS only). */
CREATE TABLE IF NOT EXISTS users (
  tg_id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  balance BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rounds (
  round_id TEXT PRIMARY KEY,
  hour_start BIGINT NOT NULL DEFAULT 0,
  winning JSONB,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now(),
  drawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rounds_hour ON rounds (hour_start DESC);

CREATE TABLE IF NOT EXISTS round_counters (
  round_id TEXT PRIMARY KEY,
  next_serial BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT UNIQUE NOT NULL,
  round_id TEXT NOT NULL REFERENCES rounds (round_id),
  tg_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  numbers JSONB NOT NULL,
  matches INT,
  prize INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_round ON tickets (round_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (tg_id, round_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  tg_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  bank TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  paid_at TIMESTAMPTZ
);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bank TEXT NOT NULL DEFAULT '';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS account_name TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  tg_id TEXT NOT NULL,
  what TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  plus BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity (tg_id, id DESC);

/* Monetag server-side postbacks — verified ad impressions/clicks. */
CREATE TABLE IF NOT EXISTS ad_events (
  id BIGSERIAL PRIMARY KEY,
  tg_id TEXT NOT NULL DEFAULT '',
  ymid TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL DEFAULT 'impression',
  zone_id TEXT NOT NULL DEFAULT '',
  request_var TEXT NOT NULL DEFAULT '',
  estimated_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_events_created ON ad_events (created_at DESC);
