import type { PGlite } from '@electric-sql/pglite';
import type { Db } from '@ossuary/core';
import { applyEmbeddedMigrations } from '@ossuary/core/poltergeist';
import { drizzle } from 'drizzle-orm/pglite';
import { APP_SCHEMA_SQL } from './appSchema';

/** The App's database: the raw PGlite client (for read-only SQL and the poltergeist) and Core's `Db`. */
export interface LedgerHandle {
  readonly client: PGlite;
  readonly db: Db;
}

/**
 * Opens the ledger on a PGlite client: Core's migrations (the browser-safe
 * embedded copy, since the page has no file system), then the App's tables.
 * Both are idempotent, so reopening a persisted database changes nothing.
 *
 * Core exports no PGlite constructor or schema; Core only uses Drizzle's
 * query builder, which needs neither, so a schema-less instance is cast to
 * Core's `Db` (design Open question Q4).
 */
export async function openLedger(client: PGlite): Promise<LedgerHandle> {
  const db = drizzle(client) as unknown as Db;
  await applyEmbeddedMigrations(db);
  await client.exec(APP_SCHEMA_SQL);
  return { client, db };
}
