// Feature: ledger-core, Property 6: Crash at any step leaves the ledger fully committed or fully absent
// Validates: Requirements 7.4, 7.1, 7.3, 9.3e
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { balance } from '../../src/ledger/balance.js';
import { postTransaction } from '../../src/ledger/postTransaction.js';
import * as schema from '../../src/schema/index.js';
import type { PostTransactionInput } from '../../src/types/index.js';
import {
  RUNS,
  createPropertyDb,
  globalEntrySum,
  runConfig,
  seedAccounts,
  toEntries,
  validTransactionArb,
  type AccountSpec,
  type PropertyDb,
} from '../helpers/arbitraries.js';
import {
  SimulatedCrash,
  calibrate,
  createCrashingDb,
  type CrashPoint,
  type CrashingDb,
} from '../helpers/crash.js';

/*
 * Crash injection lives in tests/helpers/crash.ts: a second Drizzle instance
 * on the same PGlite client whose logger throws once before statement N, plus
 * "before commit" and "after commit" wrappers around db.transaction.
 */

// The statements postTransaction runs, in order. Verified in beforeAll.
const STATEMENTS: readonly RegExp[] = [
  /^insert into "idempotency_records"/i, // 0: claim the key
  /^select .* from "accounts" .*for update/i, // 1: lock accounts
  /^select .* from "entries"/i, // 2: read balances
  /^insert into "transactions"/i, // 3: transaction row
  /^insert into "entries"/i, // 4: entry rows
  /^update "idempotency_records"/i, // 5: mark completed
];
const BEFORE_COMMIT = STATEMENTS.length; // 6
const AFTER_COMMIT = STATEMENTS.length + 1; // 7
const CRASH_POINTS = [...Array(AFTER_COMMIT + 1).keys()]; // 0..7
const describePoint = (p: number): string =>
  p < STATEMENTS.length
    ? `before statement ${p} (${STATEMENTS[p]!.source})`
    : p === BEFORE_COMMIT
      ? 'after the last statement, before commit'
      : 'after commit, before the response reached the caller';

const toCrashPoint = (p: number): CrashPoint =>
  p < STATEMENTS.length
    ? { at: 'statement', index: p }
    : p === BEFORE_COMMIT
      ? { at: 'beforeCommit' }
      : { at: 'afterCommit' };

const POOL: readonly AccountSpec[] = [
  { type: 'asset', allowOverdraft: true },
  { type: 'liability', allowOverdraft: true },
  { type: 'revenue', allowOverdraft: true },
];

interface KeyState {
  record: { status: string; response: unknown } | undefined;
  transactionIds: string[];
  entryCount: number;
}

async function keyState(db: Db, key: string): Promise<KeyState> {
  const [record] = await db
    .select({ status: schema.idempotencyRecords.status, response: schema.idempotencyRecords.response })
    .from(schema.idempotencyRecords)
    .where(eq(schema.idempotencyRecords.key, key));
  const txs = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(eq(schema.transactions.idempotencyKey, key));
  const transactionIds = txs.map((t) => t.id);
  const entryCount =
    transactionIds.length === 0
      ? 0
      : Number(
          (
            await db
              .select({ n: sql<string>`count(*)::text` })
              .from(schema.entries)
              .where(inArray(schema.entries.transactionId, transactionIds))
          )[0]!.n,
        );
  return { record, transactionIds, entryCount };
}

let pdb: PropertyDb;
let crashing: CrashingDb;
let crashingDb: Db;

beforeAll(async () => {
  pdb = await createPropertyDb();
  crashing = createCrashingDb(pdb.handle.client);
  crashingDb = crashing.db;

  // Calibrate: an uncrashed post must log exactly the expected statements, in order,
  // or the crash points above would not mean what they say.
  const ids = await seedAccounts(pdb.db, POOL);
  await calibrate(
    crashing,
    () =>
      postTransaction(crashingDb, {
        idempotencyKey: randomUUID(),
        kind: 'transfer',
        entries: [
          { accountId: ids[0]!, amount: 1n },
          { accountId: ids[1]!, amount: -1n },
        ],
      }),
    STATEMENTS,
  );
});

afterAll(async () => {
  await pdb.handle.close();
});

describe('Property 6: crash at any step leaves the ledger fully committed or fully absent', () => {
  it('is all-or-nothing at every crash point, and a retry completes exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(validTransactionArb(POOL.length, 2n ** 55n), async (shape) => {
        for (const point of CRASH_POINTS) {
          const ids = await seedAccounts(pdb.db, POOL);
          const input: PostTransactionInput = {
            idempotencyKey: randomUUID(),
            kind: 'transfer',
            entries: toEntries(shape, ids),
          };
          const applied = POOL.map((_, i) =>
            shape.filter((l) => l.account === i).reduce((s, l) => s + l.amount, 0n),
          );
          const zero = POOL.map(() => 0n);
          const balances = () => Promise.all(ids.map((id) => balance(pdb.db, id)));

          // Crash.
          crashing.arm(toCrashPoint(point));
          const crashed = await postTransaction(crashingDb, input).then(
            () => null,
            (e: unknown) => e,
          );
          crashing.disarm();
          expect(crashed, describePoint(point)).toBeInstanceOf(SimulatedCrash);

          // Exactly one of two states, and which one is fixed by whether COMMIT ran.
          const state = await keyState(pdb.db, input.idempotencyKey);
          if (point < AFTER_COMMIT) {
            expect(state, describePoint(point)).toEqual({
              record: undefined,
              transactionIds: [],
              entryCount: 0,
            });
            expect(await balances()).toEqual(zero);
          } else {
            expect(state.record?.status).toBe('completed');
            expect(state.transactionIds).toHaveLength(1);
            expect(state.entryCount).toBe(shape.length);
            expect(await balances()).toEqual(applied);
          }
          expect(await globalEntrySum(pdb.db)).toBe(0n);

          // Retry the same key to completion on a healthy connection.
          const retried = await postTransaction(pdb.db, input);
          if (point === AFTER_COMMIT) expect(retried).toEqual(state.record!.response);

          const final = await keyState(pdb.db, input.idempotencyKey);
          expect(final.record).toEqual({ status: 'completed', response: retried });
          expect(final.transactionIds).toEqual([retried.transactionId]);
          expect(final.entryCount).toBe(shape.length);
          expect(await balances()).toEqual(applied);
          expect(await globalEntrySum(pdb.db)).toBe(0n);
        }
      }),
      runConfig(RUNS.atomicity),
    );
  });
});
