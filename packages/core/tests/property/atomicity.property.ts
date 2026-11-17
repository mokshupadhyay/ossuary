// Feature: ledger-core, Property 6: Crash at any step leaves the ledger fully committed or fully absent
// Validates: Requirements 7.4, 7.1, 7.3, 9.3e
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
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

/*
 * Crash injection without touching src/.
 *
 * A second Drizzle instance shares the same PGlite client but has a query
 * logger. Drizzle calls the logger just before it executes each statement, so
 * throwing there stops the operation after exactly N statements, inside the
 * open database transaction. Postgres then rolls back, which is what happens
 * when a process dies mid-transaction and its connection drops.
 *
 * A wrapper around `db.transaction` adds the two points the logger cannot
 * reach: after the last statement but before COMMIT, and after COMMIT but
 * before the caller receives the response.
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

class SimulatedCrash extends Error {}

const ctl = { crashAt: -1, executed: 0, log: [] as string[] };

function makeCrashingDb(pdb: PropertyDb): Db {
  const base = drizzle(pdb.handle.client, {
    schema,
    logger: {
      logQuery(query: string): void {
        if (ctl.crashAt === ctl.executed) {
          // One-shot: the "process" dies here. Code that wrongly swallows the
          // error and carries on would commit a partial state, which this
          // property must then catch.
          const point = ctl.crashAt;
          ctl.crashAt = -1;
          throw new SimulatedCrash(describePoint(point));
        }
        ctl.executed += 1;
        ctl.log.push(query);
      },
    },
  }) as unknown as Db;

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (cb: (tx: unknown) => Promise<unknown>, config?: unknown) => {
          const result = await (target.transaction as (...a: unknown[]) => Promise<unknown>)(
            async (tx: unknown) => {
              const out = await cb(tx);
              if (ctl.crashAt === BEFORE_COMMIT) throw new SimulatedCrash(describePoint(BEFORE_COMMIT));
              return out;
            },
            config,
          );
          if (ctl.crashAt === AFTER_COMMIT) throw new SimulatedCrash(describePoint(AFTER_COMMIT));
          return result;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

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
let crashingDb: Db;

beforeAll(async () => {
  pdb = await createPropertyDb();
  crashingDb = makeCrashingDb(pdb);

  // Calibrate: an uncrashed post must log exactly the expected statements, in order,
  // or the crash points above would not mean what they say.
  const ids = await seedAccounts(pdb.db, POOL);
  ctl.crashAt = -1;
  ctl.executed = 0;
  ctl.log = [];
  await postTransaction(crashingDb, {
    idempotencyKey: randomUUID(),
    kind: 'transfer',
    entries: [
      { accountId: ids[0]!, amount: 1n },
      { accountId: ids[1]!, amount: -1n },
    ],
  });
  expect(ctl.log.length).toBe(STATEMENTS.length);
  ctl.log.forEach((q, i) => expect(q).toMatch(STATEMENTS[i]!));
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
          ctl.crashAt = point;
          ctl.executed = 0;
          const crashed = await postTransaction(crashingDb, input).then(
            () => null,
            (e: unknown) => e,
          );
          ctl.crashAt = -1;
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
