import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/schema/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

async function bareDb() {
  const client = new PGlite();
  const db: Db = drizzle(client, { schema });
  return { client, db };
}

async function tableNames(db: Db): Promise<string[]> {
  const res = await db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return res.rows.map((r) => String(r['table_name']));
}

describe('runMigrations', () => {
  it('creates tables and append-only trigger, and is idempotent', async () => {
    const { client, db } = await bareDb();
    await runMigrations(db);

    const expected = ['accounts', 'entries', 'idempotency_records', 'transactions'];
    expect(await tableNames(db)).toEqual(expect.arrayContaining(expected));

    const trig = await db.execute(
      sql`SELECT tgname FROM pg_trigger WHERE tgname = 'entries_append_only'`,
    );
    expect(trig.rows).toHaveLength(1);

    await runMigrations(db);
    const trig2 = await db.execute(
      sql`SELECT tgname FROM pg_trigger WHERE tgname = 'entries_append_only'`,
    );
    expect(trig2.rows).toHaveLength(1);
    const applied = await db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect((applied.rows[0] as { n: number }).n).toBe(8);

    await client.close();
  });

  it('supports transactions and tx.execute through the Db type', async () => {
    const { client, db } = await bareDb();
    await runMigrations(db);
    const res = await db.transaction(async (tx) => tx.execute(sql`SELECT 1 AS one`));
    expect(res.rows).toHaveLength(1);
    await client.close();
  });
});

describe('createDb', () => {
  it('rejects an empty connection string', () => {
    expect(() => createDb('')).toThrow();
    expect(() => createDb('   ')).toThrow();
  });

  it('returns a db without connecting', () => {
    const db = createDb('postgres://user:pass@localhost:5432/x');
    expect(db).toBeDefined();
    expect(typeof db.transaction).toBe('function');
  });
});
