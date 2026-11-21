/*
 * The app's database: PGlite (IndexedDB in the browser, memory in tests),
 * drizzle, core's embedded migrations, then the app's own tables (design D3,
 * D5). None of the app's tables holds a balance or a total: money lives only
 * in core's entries and inbox, and in Rail_Request bodies that nothing sums.
 */
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '@ossuary/core';
import { applyEmbeddedMigrations } from '@ossuary/core/poltergeist';

export type { Db };

export interface AppDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

export const IDB_NAME = 'idb://haunted-tip-jar';

/** Statements are idempotent, so this runs on every start. */
const APP_SCHEMA = [
  sql`CREATE TABLE IF NOT EXISTS tipjar_jars (
    id uuid PRIMARY KEY,
    creator text NOT NULL CHECK (length(creator) BETWEEN 1 AND 60),
    goal bigint NOT NULL CHECK (goal > 0),
    jar_account_id uuid NOT NULL UNIQUE REFERENCES accounts(account_id),
    clearing_account_id uuid NOT NULL UNIQUE REFERENCES accounts(account_id),
    rail_secret text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
  )`,
  sql`CREATE TABLE IF NOT EXISTS tipjar_rail_requests (
    key uuid PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    jar_id uuid NOT NULL REFERENCES tipjar_jars(id),
    kind text NOT NULL CHECK (kind IN ('tip', 'refund', 'chargeback')),
    request text NOT NULL,
    payment_id uuid NOT NULL,
    events jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  sql`CREATE TABLE IF NOT EXISTS tipjar_tips (
    payment_id uuid PRIMARY KEY,
    jar_id uuid NOT NULL REFERENCES tipjar_jars(id),
    request_key uuid NOT NULL UNIQUE REFERENCES tipjar_rail_requests(key),
    viewer text NOT NULL CHECK (length(viewer) BETWEEN 1 AND 40),
    message text NOT NULL CHECK (length(message) <= 140),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS tipjar_tips_jar_idx ON tipjar_tips (jar_id, created_at)`,
  sql`CREATE TABLE IF NOT EXISTS tipjar_deliveries (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    jar_id uuid NOT NULL REFERENCES tipjar_jars(id),
    event_id text NOT NULL,
    type text NOT NULL,
    attempt integer NOT NULL CHECK (attempt >= 1),
    mode text NOT NULL CHECK (mode IN ('normal', 'retry', 'duplicate', 'late', 'replay', 'stale')),
    status integer,
    outcome text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX IF NOT EXISTS tipjar_deliveries_jar_idx ON tipjar_deliveries (jar_id, seq)`,
];

/** Core's migrations, then the app tables. Idempotent. */
export async function migrateApp(db: Db): Promise<void> {
  await applyEmbeddedMigrations(db);
  for (const statement of APP_SCHEMA) await db.execute(statement);
}

/** Opens PGlite at `dataDir` (default: in memory) and migrates it. */
export async function openDatabase(options: { dataDir?: string } = {}): Promise<AppDb> {
  const client = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  const db = drizzle(client) as unknown as Db;
  try {
    await migrateApp(db);
  } catch (e) {
    await client.close();
    throw e;
  }
  return { db, client, close: () => client.close() };
}
