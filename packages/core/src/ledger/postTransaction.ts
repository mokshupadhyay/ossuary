import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  AccountNotFoundError,
  InsufficientEntriesError,
  InvalidFieldError,
  MissingIdempotencyKeyError,
  NormalBalanceViolationError,
  UnbalancedTransactionError,
} from '../errors/index.js';
import { accounts, entries, transactions } from '../schema/index.js';
import type { PostTransactionInput } from '../types/index.js';
import { hashPayload } from './hash.js';
import { claimOrReplay, completeKey, type StoredResponse } from './idempotency.js';

export type PostTransactionResult = StoredResponse;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly string[] = ['capture', 'refund', 'transfer'];

function assertUuid(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new InvalidFieldError(field, 'must be a UUID');
  }
}

/**
 * Locks every participating account, then rejects the transaction if any
 * non-overdraft account would end on the wrong side of its normal balance.
 *
 * Locks are taken with ORDER BY account_id ... FOR UPDATE, so every
 * transaction acquires them in the same ascending order (deadlock avoidance).
 * Balances are read in a separate statement AFTER the lock is held: under
 * READ COMMITTED that statement sees everything committed by any transaction
 * that held these locks before us, so the check cannot use a stale balance.
 */
async function enforceNormalBalances(
  tx: Pick<Db, 'select'>,
  entryInputs: readonly { accountId: string; amount: bigint }[],
): Promise<void> {
  // Callers pass lowercase-normalised account ids (see postTransaction).
  const delta = new Map<string, bigint>();
  for (const e of entryInputs) {
    delta.set(e.accountId, (delta.get(e.accountId) ?? 0n) + e.amount);
  }
  const ids = [...delta.keys()].sort();

  const locked = await tx
    .select({
      accountId: accounts.accountId,
      type: accounts.type,
      allowOverdraft: accounts.allowOverdraft,
    })
    .from(accounts)
    .where(inArray(accounts.accountId, ids))
    .orderBy(accounts.accountId)
    .for('update');

  const byId = new Map(locked.map((r) => [r.accountId, r]));
  const missing = ids.find((id) => !byId.has(id));
  if (missing !== undefined) throw new AccountNotFoundError(missing);

  const sums = await tx
    .select({
      accountId: entries.accountId,
      total: sql<string>`coalesce(sum(${entries.amount}), 0)::text`,
    })
    .from(entries)
    .where(inArray(entries.accountId, ids))
    .groupBy(entries.accountId);
  const current = new Map(sums.map((r) => [r.accountId, BigInt(r.total)]));

  for (const id of ids) {
    const acct = byId.get(id)!;
    if (acct.allowOverdraft) continue;
    const prospective = (current.get(id) ?? 0n) + delta.get(id)!;
    const debitNormal = acct.type === 'asset' || acct.type === 'expense';
    if (debitNormal ? prospective < 0n : prospective > 0n) {
      throw new NormalBalanceViolationError(id, prospective);
    }
  }
}

/**
 * Shared write path: lock accounts, check normal balances, insert the
 * transaction row and its entries. Runs on whatever handle it is given.
 */
async function writeTransaction(
  tx: Pick<Db, 'select' | 'insert'>,
  idempotencyKey: string,
  kind: PostTransactionInput['kind'],
  paymentId: string | null,
  normalized: readonly { accountId: string; amount: bigint }[],
): Promise<PostTransactionResult> {
  await enforceNormalBalances(tx, normalized);

  const transactionId = randomUUID();
  await tx.insert(transactions).values({
    id: transactionId,
    kind,
    paymentId,
    idempotencyKey,
  });

  const rows = normalized.map((e) => ({
    id: randomUUID(),
    transactionId,
    accountId: e.accountId,
    amount: e.amount,
  }));
  await tx.insert(entries).values(rows);

  return { transactionId, entryIds: rows.map((r) => r.id) };
}

/**
 * Posts a balanced set of entries atomically, claiming the idempotency key in
 * the same database transaction. All validation runs before any DB call.
 * Zero-amount entries are allowed: they cannot unbalance a transaction.
 *
 * Optional `callerTx`: an open Drizzle transaction owned by the caller (used by
 * `refund`). In that mode this function does NOT open a transaction, claim the
 * key, hash the payload, resolve existing keys, or mark the record `completed`.
 * Contract: the caller must already have claimed `idempotencyKey` (a row in
 * `idempotency_records`) on the same `callerTx`, because `transactions.idempotency_key`
 * is a foreign key to it, and the caller is responsible for the request-hash
 * check and for setting the final `completed` status. Validation, account
 * locking, normal-balance checks and entry writes all still run, on `callerTx`.
 */
export async function postTransaction(
  db: Db,
  input: PostTransactionInput,
  callerTx?: Tx,
): Promise<PostTransactionResult> {
  const { idempotencyKey, entries: entryInputs, kind, paymentId } = (input ??
    {}) as Partial<PostTransactionInput>;

  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '') {
    throw new MissingIdempotencyKeyError();
  }
  assertUuid('idempotencyKey', idempotencyKey);

  if (!Array.isArray(entryInputs)) throw new InvalidFieldError('entries', 'must be an array');
  if (entryInputs.length < 2) throw new InsufficientEntriesError();

  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    throw new InvalidFieldError('kind', 'must be capture, refund or transfer');
  }
  if (paymentId !== undefined && paymentId !== null) assertUuid('paymentId', paymentId);

  for (const e of entryInputs) {
    assertUuid('accountId', e?.accountId);
    if (typeof e.amount !== 'bigint') {
      throw new InvalidFieldError('amount', 'must be a bigint');
    }
  }

  const sum = entryInputs.reduce((s, e) => s + e.amount, 0n);
  if (sum !== 0n) throw new UnbalancedTransactionError(sum);

  // Normalise once: Postgres stores UUIDs lowercase, so hashing, locking,
  // balance checks and inserts must all see the same canonical form.
  const normalized = entryInputs.map((e) => ({
    accountId: e.accountId.toLowerCase(),
    amount: e.amount,
  }));

  // Same for paymentId, so a retry in a different letter case is a replay.
  const normalizedPaymentId =
    paymentId !== undefined && paymentId !== null ? paymentId.toLowerCase() : null;

  // Caller-owned transaction: the caller has already claimed the key.
  if (callerTx) {
    return writeTransaction(callerTx, idempotencyKey, kind, normalizedPaymentId, normalized);
  }

  const requestHash = hashPayload({
    entries: normalized,
    kind,
    paymentId: normalizedPaymentId,
  });

  return db.transaction(async (tx) => {
    const claim = await claimOrReplay(tx, idempotencyKey, requestHash);
    if (!claim.claimed) return claim.response;

    const response = await writeTransaction(
      tx,
      idempotencyKey,
      kind,
      normalizedPaymentId,
      normalized,
    );
    await completeKey(tx, idempotencyKey, response);

    return response;
  });
}
