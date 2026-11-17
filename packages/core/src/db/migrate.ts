import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

// `dialect` and `session` are @internal on PgDatabase. Every per-driver
// migrator (pglite, neon-serverless, ...) is just this same two-line body,
// so we reuse it to work with any driver behind the shared `Db` type.
interface MigratableDb {
  dialect: PgDialect;
  session: PgSession;
}

/** Applies all pending migrations. Idempotent: applied migrations are skipped. */
export async function runMigrations(db: Db): Promise<void> {
  const { dialect, session } = db as unknown as MigratableDb;
  const migrations = readMigrationFiles({ migrationsFolder });
  await dialect.migrate(migrations, session, { migrationsFolder });
}
