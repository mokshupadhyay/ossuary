import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import { NormalBalanceViolationError } from '../../src/errors/index.js';
import { entries, idempotencyRecords, transactions } from '../../src/schema/index.js';
import type { Db } from '../../src/db/client.js';
import type { AccountType } from '../../src/types/index.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;
let bank: string; // overdraft-enabled counterparty

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
  bank = randomUUID();
  await createAccount(db, { accountId: bank, name: 'bank', type: 'asset', allowOverdraft: true });
});
afterEach(async () => {
  await handle.close();
});

const mk = async (type: AccountType, allowOverdraft = false, accountId = randomUUID()) => {
  await createAccount(db, { accountId, name: type, type, allowOverdraft });
  return accountId;
};

/** Post `amount` to `acct`, balanced against the bank account. */
const post = (acct: string, amount: bigint) =>
  postTransaction(db, {
    idempotencyKey: randomUUID(),
    kind: 'transfer',
    entries: [
      { accountId: acct, amount },
      { accountId: bank, amount: -amount },
    ],
  });

const counts = async () => ({
  keys: (await handle.db.select().from(idempotencyRecords)).length,
  txs: (await handle.db.select().from(transactions)).length,
  entries: (await handle.db.select().from(entries)).length,
});

describe('debit-normal accounts (asset, expense)', () => {
  for (const type of ['asset', 'expense'] as const) {
    it(`${type}: debit then credit within limit accepted, credit below 0 rejected, exactly 0 accepted`, async () => {
      const acct = await mk(type);
      await post(acct, 100n);
      await post(acct, -60n);
      await expect(post(acct, -41n)).rejects.toMatchObject({
        constructor: NormalBalanceViolationError,
        accountId: acct,
        balance: -1n,
      });
      await post(acct, -40n); // exactly 0n
    });
  }
});

describe('credit-normal accounts (liability, revenue)', () => {
  for (const type of ['liability', 'revenue'] as const) {
    it(`${type}: credit accepted, debit above 0 rejected, exactly 0 accepted`, async () => {
      const acct = await mk(type);
      await post(acct, -100n);
      await post(acct, 60n);
      await expect(post(acct, 41n)).rejects.toMatchObject({
        constructor: NormalBalanceViolationError,
        accountId: acct,
        balance: 1n,
      });
      await post(acct, 40n); // exactly 0n
    });
  }
});

describe('allow_overdraft', () => {
  it('lets an asset go negative and a liability go positive', async () => {
    const asset = await mk('asset', true);
    const liab = await mk('liability', true);
    await post(asset, -5n);
    await post(liab, 5n);
    expect(await counts()).toMatchObject({ txs: 2 });
  });
});

describe('netting within one transaction', () => {
  it('sums multiple entries to one account before checking', async () => {
    const acct = await mk('asset');
    await post(acct, 100n);
    // net -50: 100 -> 50 is fine
    await postTransaction(db, {
      idempotencyKey: randomUUID(),
      kind: 'transfer',
      entries: [
        { accountId: acct, amount: 100n },
        { accountId: acct, amount: -150n },
        { accountId: bank, amount: 50n },
      ],
    });
    // leg order: -80 first would dip below 0 (50-80), but net +20 is fine
    await postTransaction(db, {
      idempotencyKey: randomUUID(),
      kind: 'transfer',
      entries: [
        { accountId: acct, amount: -80n },
        { accountId: acct, amount: 100n },
        { accountId: bank, amount: -20n },
      ],
    });
    // net -80 from 70 -> -10 rejected
    await expect(
      postTransaction(db, {
        idempotencyKey: randomUUID(),
        kind: 'transfer',
        entries: [
          { accountId: acct, amount: 10n },
          { accountId: acct, amount: -90n },
          { accountId: bank, amount: 80n },
        ],
      }),
    ).rejects.toMatchObject({ accountId: acct, balance: -10n });
  });
});

describe('rejection', () => {
  it('writes nothing, leaves the key unclaimed, and the key is reusable', async () => {
    const acct = await mk('asset');
    const key = randomUUID();
    const bad = {
      idempotencyKey: key,
      kind: 'transfer' as const,
      entries: [
        { accountId: acct, amount: -5n },
        { accountId: bank, amount: 5n },
      ],
    };
    await expect(postTransaction(db, bad)).rejects.toBeInstanceOf(NormalBalanceViolationError);
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });

    const ok = await postTransaction(db, {
      ...bad,
      entries: [
        { accountId: acct, amount: 5n },
        { accountId: bank, amount: -5n },
      ],
    });
    expect(ok.entryIds).toHaveLength(2);
    expect(await counts()).toEqual({ keys: 1, txs: 1, entries: 2 });
  });

  it('reports the lowest violating account id when several violate', async () => {
    const lo = await mk('asset', false, '00000000-0000-4000-8000-000000000001');
    const hi = await mk('asset', false, 'ffffffff-0000-4000-8000-000000000001');
    const err = await postTransaction(db, {
      idempotencyKey: randomUUID(),
      kind: 'transfer',
      entries: [
        { accountId: hi, amount: -3n },
        { accountId: lo, amount: -2n },
        { accountId: bank, amount: 5n },
      ],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NormalBalanceViolationError);
    expect(err).toMatchObject({ accountId: lo, balance: -2n });
    expect(await counts()).toEqual({ keys: 0, txs: 0, entries: 0 });
  });

  it('does not lock or check on replay of a completed key', async () => {
    const acct = await mk('asset');
    const i = {
      idempotencyKey: randomUUID(),
      kind: 'transfer' as const,
      entries: [
        { accountId: acct, amount: 10n },
        { accountId: bank, amount: -10n },
      ],
    };
    const first = await postTransaction(db, i);
    await post(acct, -10n); // drains the account to 0
    expect(await postTransaction(db, i)).toEqual(first);
  });
});
