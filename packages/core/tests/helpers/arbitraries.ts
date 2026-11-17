import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { createAccount } from '../../src/ledger/accounts.js';
import type { AccountType, EntryInput } from '../../src/types/index.js';
import { createTestDb, type TestDbHandle } from './createTestDb.js';

/*
 * Shared fast-check arbitraries and helpers for the property tests.
 *
 * Arbitraries generate *shapes* that refer to accounts by pool index, not by
 * id. Each property run seeds fresh accounts (new UUIDs) in one shared
 * database per test file, so iterations never touch each other's accounts and
 * shrinking can safely re-run a case against the same database.
 *
 * Run counts are kept modest so the whole `vitest --run` stays well under the
 * 120 s budget (Req 9.4). They override the `{ numRuns: 100 }` in tasks.md at
 * the user's request.
 */

export const SEQUENCE_MIN = 1;
export const SEQUENCE_MAX = 200; // Req 9.2: sequences of 1 to 200 operations

export const RUNS = {
  entrySum: 8, // each run is a sequence of up to 200 posts
  replay: 25,
  anyOrder: 25,
  refundCap: 30,
  refundBoundary: 30,
  atomicity: 15, // each run tries every crash point
} as const;

/**
 * Upper bound on one property run, shrinking included. Shrinking a long
 * sequence against a real database can otherwise run for minutes; on
 * interrupt fast-check reports the counterexample found so far and the run
 * counts as a failure, so it can never pass silently.
 */
export const PROPERTY_TIME_LIMIT_MS = 45_000;

/** fast-check options shared by every property. */
export const runConfig = (numRuns: number) =>
  ({
    numRuns,
    interruptAfterTimeLimit: PROPERTY_TIME_LIMIT_MS,
    markInterruptAsFailure: true,
  }) as const;

// ---------------------------------------------------------------------------
// Transaction shapes
// ---------------------------------------------------------------------------

export interface LegShape {
  account: number; // index into the seeded account pool
  amount: bigint;
}
export type TxShape = LegShape[];

/**
 * A balanced transaction: 1 to 3 free legs with amounts in [-max, max]
 * (zero allowed), plus a closing leg that makes the sum exactly 0n.
 * Always at least 2 entries. Legs may repeat an account.
 */
export function validTransactionArb(poolSize: number, maxAmount: bigint): fc.Arbitrary<TxShape> {
  const leg = fc.record({
    account: fc.nat({ max: poolSize - 1 }),
    amount: fc.bigInt({ min: -maxAmount, max: maxAmount }),
  });
  return fc
    .tuple(fc.array(leg, { minLength: 1, maxLength: 3 }), fc.nat({ max: poolSize - 1 }))
    .map(([legs, closing]) => [
      ...legs,
      { account: closing, amount: -legs.reduce((s, l) => s + l.amount, 0n) },
    ]);
}

export function toEntries(shape: TxShape, ids: readonly string[]): EntryInput[] {
  return shape.map((l) => ({ accountId: ids[l.account]!, amount: l.amount }));
}

// ---------------------------------------------------------------------------
// Capture and refund shapes
// ---------------------------------------------------------------------------

/** Positive debit amounts (asset side) and positive credit amounts (revenue side) with equal totals. */
export interface CaptureShape {
  debits: bigint[]; // 1 or 2 legs, one per debit account
  credits: bigint[]; // 1 or 2 legs, one per credit account
}

export function captureTransactionArb(maxAmount: bigint): fc.Arbitrary<CaptureShape> {
  return fc
    .array(fc.bigInt({ min: 1n, max: maxAmount }), { minLength: 1, maxLength: 2 })
    .chain((debits) => {
      const total = debits.reduce((s, d) => s + d, 0n);
      const credits: fc.Arbitrary<bigint[]> =
        total === 1n
          ? fc.constant<bigint[]>([1n])
          : fc.oneof(
              fc.constant<bigint[]>([total]),
              fc.bigInt({ min: 1n, max: total - 1n }).map((c) => [c, total - c]),
            );
      return credits.map((c) => ({ debits, credits: c }));
    });
}

export const capturedTotal = (c: CaptureShape): bigint => c.debits.reduce((s, d) => s + d, 0n);

export function captureEntries(
  c: CaptureShape,
  debitIds: readonly string[],
  creditIds: readonly string[],
): EntryInput[] {
  return [
    ...c.debits.map((amount, i) => ({ accountId: debitIds[i]!, amount })),
    ...c.credits.map((amount, i) => ({ accountId: creditIds[i]!, amount: -amount })),
  ];
}

/** Any positive refund amount: mostly small enough to fit sometimes, occasionally huge. */
export function refundArb(typicalMax: bigint): fc.Arbitrary<bigint> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.bigInt({ min: 1n, max: typicalMax }) },
    { weight: 1, arbitrary: fc.bigInt({ min: 1n, max: 2n ** 62n }) },
  );
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

export interface PropertyDb {
  handle: TestDbHandle;
  db: Db;
}

/** One migrated in-memory database, meant to be shared by all runs of a property. */
export async function createPropertyDb(): Promise<PropertyDb> {
  const handle = await createTestDb();
  return { handle, db: handle.db as unknown as Db };
}

export interface AccountSpec {
  type: AccountType;
  allowOverdraft: boolean;
}

/** Creates fresh accounts (new UUIDs) and returns their ids in spec order. */
export async function seedAccounts(db: Db, specs: readonly AccountSpec[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, s] of specs.entries()) {
    const accountId = randomUUID();
    await createAccount(db, {
      accountId,
      name: `acct-${i}-${s.type}`,
      type: s.type,
      allowOverdraft: s.allowOverdraft,
    });
    ids.push(accountId);
  }
  return ids;
}

const scalar = async (db: Db, query: ReturnType<typeof sql>): Promise<bigint> => {
  const r = await db.execute(query);
  return BigInt(String(r.rows[0]!['v']));
};

/** SUM of every entry in the database. */
export const globalEntrySum = (db: Db): Promise<bigint> =>
  scalar(db, sql`select coalesce(sum(amount), 0)::text as v from entries`);

export interface TableCounts {
  transactions: bigint;
  entries: bigint;
  idempotencyRecords: bigint;
}

export async function tableCounts(db: Db): Promise<TableCounts> {
  const r = await db.execute(sql`
    select (select count(*) from transactions)::text as t,
           (select count(*) from entries)::text as e,
           (select count(*) from idempotency_records)::text as k`);
  const row = r.rows[0]!;
  return {
    transactions: BigInt(String(row['t'])),
    entries: BigInt(String(row['e'])),
    idempotencyRecords: BigInt(String(row['k'])),
  };
}

/** Sum of positive entry amounts across a payment's transactions of one kind. */
export const positiveSumForPayment = (
  db: Db,
  paymentId: string,
  kind: 'capture' | 'refund',
): Promise<bigint> =>
  scalar(
    db,
    sql`select coalesce(sum(e.amount), 0)::text as v
        from entries e join transactions t on t.id = e.transaction_id
        where t.payment_id = ${paymentId} and t.kind = ${kind} and e.amount > 0`,
  );
