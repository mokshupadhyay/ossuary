// poltergeist-engine Requirement 14.4: browser-safe migrations equal the files on disk.
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EMBEDDED_MIGRATIONS } from '../../src/poltergeist/embeddedMigrations.generated.js';
import { applyEmbeddedMigrations } from '../../src/poltergeist/migrate.js';
import * as schema from '../../src/schema/index.js';

const migrationsFolder = fileURLToPath(new URL('../../src/migrations', import.meta.url));
const clients: PGlite[] = [];

async function fresh(): Promise<Db> {
  const client = new PGlite();
  clients.push(client);
  return drizzle(client, { schema }) as unknown as Db;
}

async function history(db: Db) {
  const r = await db.execute(sql`select hash, created_at::text as at from drizzle.__drizzle_migrations order by id`);
  return r.rows;
}

async function tables(db: Db) {
  const r = await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  );
  return r.rows.map((row) => row['table_name']);
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

describe('embedded migrations', () => {
  it('equal readMigrationFiles on src/migrations (run `pnpm --filter core embed-migrations` if this fails)', () => {
    expect(JSON.parse(JSON.stringify(EMBEDDED_MIGRATIONS))).toEqual(
      JSON.parse(JSON.stringify(readMigrationFiles({ migrationsFolder }))),
    );
  });

  it('record the same history and tables as runMigrations, and are idempotent', async () => {
    const a = await fresh();
    const b = await fresh();
    await applyEmbeddedMigrations(a);
    await runMigrations(b);
    expect(await history(a)).toEqual(await history(b));
    expect(await tables(a)).toEqual(await tables(b));
    expect((await history(a)).length).toBe(EMBEDDED_MIGRATIONS.length);

    await applyEmbeddedMigrations(a);
    expect((await history(a)).length).toBe(EMBEDDED_MIGRATIONS.length);
    // A database migrated from files accepts the embedded copy as already applied.
    await applyEmbeddedMigrations(b);
    expect((await history(b)).length).toBe(EMBEDDED_MIGRATIONS.length);
  });
});
