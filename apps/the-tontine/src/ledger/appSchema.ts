/*
 * The App's own records (design T2). They hold intent and configuration, never
 * money: the only amount is each Circle's configured contribution. Balances
 * are always Core's balance(), the sum of ledger entries. Idempotent, so it
 * runs on every open.
 */
export const APP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tontine_settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS tontine_circles (
  circle_id           uuid PRIMARY KEY,
  seq                 bigserial NOT NULL UNIQUE,
  name                varchar(60) NOT NULL,
  asset               text NOT NULL CHECK (asset = 'USDC'),
  contribution        bigint NOT NULL CHECK (contribution > 0),
  member_count        integer NOT NULL CHECK (member_count BETWEEN 2 AND 12),
  clearing_account_id uuid NOT NULL UNIQUE REFERENCES accounts (account_id),
  pot_account_id      uuid NOT NULL UNIQUE REFERENCES accounts (account_id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tontine_members (
  circle_id         uuid NOT NULL REFERENCES tontine_circles (circle_id),
  position          integer NOT NULL CHECK (position >= 0),
  member_id         uuid NOT NULL UNIQUE,
  name              varchar(40) NOT NULL,
  wallet_account_id uuid NOT NULL UNIQUE REFERENCES accounts (account_id),
  PRIMARY KEY (circle_id, position)
);

CREATE TABLE IF NOT EXISTS tontine_dues (
  circle_id       uuid NOT NULL,
  round           integer NOT NULL CHECK (round >= 1),
  position        integer NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  payment_id      uuid NOT NULL UNIQUE,
  PRIMARY KEY (circle_id, round, position),
  FOREIGN KEY (circle_id, position) REFERENCES tontine_members (circle_id, position)
);

CREATE TABLE IF NOT EXISTS tontine_rounds (
  circle_id          uuid NOT NULL REFERENCES tontine_circles (circle_id),
  round              integer NOT NULL CHECK (round >= 1),
  recipient_position integer NOT NULL,
  payout_key         uuid NOT NULL UNIQUE,
  PRIMARY KEY (circle_id, round),
  FOREIGN KEY (circle_id, recipient_position) REFERENCES tontine_members (circle_id, position)
);

CREATE TABLE IF NOT EXISTS tontine_notices (
  circle_id uuid NOT NULL,
  round     integer NOT NULL,
  position  integer NOT NULL,
  noted_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (circle_id, round, position),
  FOREIGN KEY (circle_id, round, position) REFERENCES tontine_dues (circle_id, round, position)
);

CREATE TABLE IF NOT EXISTS tontine_receipts (
  outbox_key  uuid PRIMARY KEY,
  event_id    text NOT NULL,
  payment_id  uuid NOT NULL,
  topic       text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS tontine_receipts_payment_idx ON tontine_receipts (payment_id);
`;
