import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import { AccountNotFoundError, InvalidFieldError } from '../../src/errors/index.js';
import type { Db } from '../../src/db/client.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;
let asset: string;
let liability: string;

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  asset = randomUUID();
  liability = randomUUID();
  await createAccount(db, { accountId: asset, name: 'Cash', type: 'asset' });
  await createAccount(db, { accountId: liability, name: 'Owed', type: 'liability' });
});

afterEach(async () => {
  await handle.close();
});

const post = (amount: bigint, from = liability, to = asset) =>
  postTransaction(db, {
    idempotencyKey: randomUUID(),
    kind: 'transfer',
    entries: [
      { accountId: to, amount },
      { accountId: from, amount: -amount },
    ],
  });

describe('balance', () => {
  it('returns 0n for an account with no entries', async () => {
    expect(await balance(db, asset)).toBe(0n);
  });

  it('sums entries, including negative credit-normal balances', async () => {
    await post(500n);
    await post(250n);
    expect(await balance(db, asset)).toBe(750n);
    expect(await balance(db, liability)).toBe(-750n);
  });

  it('reflects a new post immediately', async () => {
    await post(100n);
    expect(await balance(db, asset)).toBe(100n);
    await post(40n);
    expect(await balance(db, asset)).toBe(140n);
  });

  it('is exact beyond 2^53', async () => {
    const big = 9007199254740993123n;
    await post(big);
    await post(1n);
    expect(await balance(db, asset)).toBe(big + 1n);
    expect(await balance(db, liability)).toBe(-(big + 1n));
  });

  it('throws AccountNotFoundError for an unknown valid UUID', async () => {
    await expect(balance(db, randomUUID())).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('throws InvalidFieldError for a malformed id', async () => {
    await expect(balance(db, 'nope')).rejects.toBeInstanceOf(InvalidFieldError);
  });

  it('accepts an uppercase account id', async () => {
    await post(321n);
    expect(await balance(db, asset.toUpperCase())).toBe(321n);
  });
});
