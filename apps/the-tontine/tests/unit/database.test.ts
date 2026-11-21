import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, postTransaction } from '@ossuary/core';
import { openLedger, type LedgerHandle } from '../../src/ledger/database';

let client: PGlite;
let ledger: LedgerHandle;

beforeAll(async () => {
  client = new PGlite();
  ledger = await openLedger(client);
});
afterAll(() => client.close());

const tables = async () =>
  (await client.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map(
    (r) => r.t,
  );

describe('openLedger', () => {
  it("creates Core's tables and the App's tables", async () => {
    const t = await tables();
    for (const name of ['accounts', 'transactions', 'entries', 'idempotency_records', 'webhook_events', 'outbox_messages']) {
      expect(t).toContain(name);
    }
    for (const name of ['tontine_settings', 'tontine_circles', 'tontine_members', 'tontine_dues', 'tontine_rounds', 'tontine_notices', 'tontine_receipts']) {
      expect(t).toContain(name);
    }
  });

  it('is idempotent: opening again keeps every row and migration', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await createAccount(ledger.db, { accountId: a, name: 'a', type: 'asset', allowOverdraft: true });
    await createAccount(ledger.db, { accountId: b, name: 'b', type: 'revenue' });
    await postTransaction(ledger.db, {
      idempotencyKey: crypto.randomUUID(),
      kind: 'transfer',
      entries: [
        { accountId: a, amount: 5n },
        { accountId: b, amount: -5n },
      ],
    });
    const before = await client.query('SELECT count(*)::int AS n FROM entries');
    const migrations = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    await openLedger(client);
    expect((await client.query('SELECT count(*)::int AS n FROM entries')).rows).toEqual(before.rows);
    expect((await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows).toEqual(migrations.rows);
  });

  it('App tables hold no amount except the configured contribution', async () => {
    const cols = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name LIKE 'tontine_%' AND data_type IN ('bigint', 'numeric', 'integer', 'double precision', 'real')`,
    );
    const money = cols.rows.filter((r) => !['position', 'round', 'recipient_position', 'member_count', 'seq'].includes(r.column_name));
    expect(money).toEqual([{ table_name: 'tontine_circles', column_name: 'contribution' }]);
  });
});
