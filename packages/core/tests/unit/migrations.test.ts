import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let h: TestDbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await h.client.query<T>(sql, params)).rows;
}

describe('migrations on pglite', () => {
  it('creates the four tables', async () => {
    const r = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['accounts', 'transactions', 'entries', 'idempotency_records']],
    );
    expect(r.map((x) => x.table_name).sort()).toEqual([
      'accounts',
      'entries',
      'idempotency_records',
      'transactions',
    ]);
  });

  it('has a unique index on idempotency_records(key)', async () => {
    const r = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'idempotency_records'`,
    );
    expect(
      r.some((x) => /UNIQUE/i.test(x.indexdef) && /\(key\)/.test(x.indexdef)),
    ).toBe(true);
  });

  async function fks(table: string) {
    return rows<{ col: string; ref_table: string; ref_col: string }>(
      `SELECT a.attname AS col, cf.relname AS ref_table, af.attname AS ref_col
       FROM pg_constraint c
       JOIN pg_class ct ON ct.oid = c.conrelid
       JOIN pg_class cf ON cf.oid = c.confrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
       WHERE c.contype = 'f' AND ct.relname = $1`,
      [table],
    );
  }

  it('has FKs on entries to transactions and accounts', async () => {
    const r = await fks('entries');
    expect(r).toContainEqual({
      col: 'transaction_id',
      ref_table: 'transactions',
      ref_col: 'id',
    });
    expect(r).toContainEqual({
      col: 'account_id',
      ref_table: 'accounts',
      ref_col: 'account_id',
    });
  });

  it('has FK from transactions.idempotency_key to idempotency_records.key', async () => {
    expect(await fks('transactions')).toContainEqual({
      col: 'idempotency_key',
      ref_table: 'idempotency_records',
      ref_col: 'key',
    });
  });

  it('rejects transactions.kind values outside the enum', async () => {
    await expect(
      h.client.query(
        `INSERT INTO transactions (id, kind) VALUES (gen_random_uuid(), 'bogus')`,
      ),
    ).rejects.toThrow(/invalid input value for enum/i);
    await expect(
      h.client.query(
        `INSERT INTO transactions (id, kind) VALUES (gen_random_uuid(), 'capture')`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('createTestDb isolation', () => {
  it('gives each call an independent database', async () => {
    const a = await createTestDb();
    const b = await createTestDb();
    try {
      await a.client.query(
        `INSERT INTO accounts (account_id, name, type) VALUES (gen_random_uuid(), 'x', 'asset')`,
      );
      const ra = await a.client.query('SELECT count(*)::int AS n FROM accounts');
      const rb = await b.client.query('SELECT count(*)::int AS n FROM accounts');
      expect((ra.rows[0] as { n: number }).n).toBe(1);
      expect((rb.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
