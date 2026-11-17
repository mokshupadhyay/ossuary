import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import type { Db } from '../../src/db/client.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;
let a: string;
let b: string;
let entryId: string;

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  a = randomUUID();
  b = randomUUID();
  await createAccount(db, { accountId: a, name: 'A', type: 'asset', allowOverdraft: true });
  await createAccount(db, { accountId: b, name: 'B', type: 'liability', allowOverdraft: true });
  const res = await postTransaction(db, {
    idempotencyKey: randomUUID(),
    kind: 'transfer',
    entries: [
      { accountId: a, amount: 100n },
      { accountId: b, amount: -100n },
    ],
  });
  entryId = res.entryIds[0]!;
});

afterEach(async () => {
  await handle.close();
});

const count = async () =>
  Number(
    (await handle.client.query<{ n: string }>('SELECT count(*)::text AS n FROM entries')).rows[0]!.n,
  );

const sumAll = async () =>
  (await handle.client.query<{ s: string }>('SELECT coalesce(sum(amount),0)::text AS s FROM entries'))
    .rows[0]!.s;

describe('entries are append-only', () => {
  it('rejects UPDATE and leaves the row unchanged', async () => {
    await expect(
      handle.client.query('UPDATE entries SET amount = 999 WHERE id = $1', [entryId]),
    ).rejects.toThrow(/append-only/);
    const r = await handle.client.query<{ amount: string }>(
      'SELECT amount::text AS amount FROM entries WHERE id = $1',
      [entryId],
    );
    expect(r.rows[0]!.amount).toBe('100');
  });

  it('rejects DELETE and leaves the count unchanged', async () => {
    await expect(
      handle.client.query('DELETE FROM entries WHERE id = $1', [entryId]),
    ).rejects.toThrow(/append-only/);
    expect(await count()).toBe(2);
  });

  it('zero-match UPDATE/DELETE succeed as no-ops (row triggers never fire without a row)', async () => {
    const missing = randomUUID();
    const u = await handle.client.query('UPDATE entries SET amount = 1 WHERE id = $1', [missing]);
    const d = await handle.client.query('DELETE FROM entries WHERE id = $1', [missing]);
    expect(u.affectedRows).toBe(0);
    expect(d.affectedRows).toBe(0);
    expect(await count()).toBe(2);
  });

  it('rejects TRUNCATE', async () => {
    await expect(handle.client.exec('TRUNCATE entries')).rejects.toThrow(/append-only/);
    expect(await count()).toBe(2);
  });

  it('keeps the global sum at zero and balances unchanged after all attempts', async () => {
    const before = [await balance(db, a), await balance(db, b)];
    await handle.client.query('UPDATE entries SET amount = 1').catch(() => undefined);
    await handle.client.query('DELETE FROM entries').catch(() => undefined);
    await handle.client.exec('TRUNCATE entries').catch(() => undefined);
    expect(await sumAll()).toBe('0');
    expect([await balance(db, a), await balance(db, b)]).toEqual(before);
    expect(before).toEqual([100n, -100n]);
  });
});
