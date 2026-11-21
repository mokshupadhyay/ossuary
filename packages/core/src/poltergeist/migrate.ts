import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import { EMBEDDED_MIGRATIONS } from './embeddedMigrations.generated.js';

// `dialect` and `session` are @internal on PgDatabase; src/db/migrate.ts uses the same two.
interface MigratableDb {
  dialect: PgDialect;
  session: PgSession;
}

/**
 * Applies every migration from the embedded copy of src/migrations, with the
 * same `dialect.migrate` call as `runMigrations`, so the recorded history is
 * identical. Browser-safe: no file system, no URL module (design D8).
 * Idempotent: applied migrations are skipped.
 */
export async function applyEmbeddedMigrations(db: Db): Promise<void> {
  const { dialect, session } = db as unknown as MigratableDb;
  await dialect.migrate(EMBEDDED_MIGRATIONS as MigrationMeta[], session, { migrationsFolder: '' });
}
