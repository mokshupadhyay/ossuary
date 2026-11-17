import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccount, getAccount } from '../../src/ledger/accounts.js';
import {
  AccountNotFoundError,
  DuplicateAccountError,
  InvalidAccountTypeError,
  InvalidFieldError,
  MissingFieldError,
} from '../../src/errors/index.js';
import { accounts } from '../../src/schema/index.js';
import type { Db } from '../../src/db/client.js';
import type { AccountType } from '../../src/types/index.js';
import { createTestDb, type TestDbHandle } from '../helpers/createTestDb.js';

let handle: TestDbHandle;
let db: Db;

beforeEach(async () => {
  handle = await createTestDb();
  db = handle.db as unknown as Db;
});

afterEach(async () => {
  await handle.close();
});

const count = async () => (await handle.db.select().from(accounts)).length;
const valid = () => ({ accountId: randomUUID(), name: 'Cash', type: 'asset' as AccountType });

describe('createAccount / getAccount', () => {
  it('round-trips the full record', async () => {
    const input = { ...valid(), allowOverdraft: true };
    const created = await createAccount(db, input);
    expect(created).toMatchObject(input);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await getAccount(db, input.accountId)).toEqual(created);
  });

  it('defaults allowOverdraft to false and keeps explicit true', async () => {
    const a = await createAccount(db, valid());
    expect(a.allowOverdraft).toBe(false);
    const b = await createAccount(db, { ...valid(), allowOverdraft: true });
    expect(b.allowOverdraft).toBe(true);
  });

  it.each(['accountId', 'name', 'type'] as const)('rejects missing %s', async (field) => {
    for (const bad of [undefined, null, ''] as const) {
      const input = { ...valid(), [field]: bad } as never;
      const err = await createAccount(db, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingFieldError);
      expect((err as MissingFieldError).field).toBe(field);
    }
    expect(await count()).toBe(0);
  });

  it('rejects an invalid type and writes nothing', async () => {
    const err = await createAccount(db, { ...valid(), type: 'equity' as never }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidAccountTypeError);
    expect((err as InvalidAccountTypeError).value).toBe('equity');
    expect(await count()).toBe(0);
  });

  it('rejects a non-UUID accountId with InvalidFieldError', async () => {
    await expect(createAccount(db, { ...valid(), accountId: 'nope' })).rejects.toBeInstanceOf(
      InvalidFieldError,
    );
    expect(await count()).toBe(0);
  });

  it('rejects a duplicate accountId and leaves the original unchanged', async () => {
    const original = await createAccount(db, valid());
    await expect(
      createAccount(db, {
        accountId: original.accountId,
        name: 'Other',
        type: 'revenue',
        allowOverdraft: true,
      }),
    ).rejects.toBeInstanceOf(DuplicateAccountError);
    expect(await getAccount(db, original.accountId)).toEqual(original);
    expect(await count()).toBe(1);
  });

  it('enforces name length 1-255 by code points', async () => {
    const one = await createAccount(db, { ...valid(), name: 'x' });
    expect(one.name).toBe('x');
    const max = await createAccount(db, { ...valid(), name: 'a'.repeat(255) });
    expect(max.name).toHaveLength(255);
    // 255 astral characters = 510 UTF-16 units, still valid.
    const emoji = await createAccount(db, { ...valid(), name: '👻'.repeat(255) });
    expect([...emoji.name]).toHaveLength(255);

    await expect(createAccount(db, { ...valid(), name: '' })).rejects.toBeInstanceOf(
      MissingFieldError,
    );
    await expect(
      createAccount(db, { ...valid(), name: 'a'.repeat(256) }),
    ).rejects.toBeInstanceOf(InvalidFieldError);
    await expect(
      createAccount(db, { ...valid(), name: '👻'.repeat(256) }),
    ).rejects.toBeInstanceOf(InvalidFieldError);
    expect(await count()).toBe(3);
  });

  it('getAccount throws AccountNotFoundError for an unknown id', async () => {
    await expect(getAccount(db, randomUUID())).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});
