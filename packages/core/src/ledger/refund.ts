import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  InvalidFieldError,
  InvalidRefundAmountError,
  MissingFieldError,
  MissingIdempotencyKeyError,
  PaymentNotFoundError,
  RefundCapExceededError,
} from '../errors/index.js';
import { entries, transactions } from '../schema/index.js';
import type { RefundInput } from '../types/index.js';
import { hashPayload } from './hash.js';
import { claimOrReplay, completeKey } from './idempotency.js';
import { postTransaction, type PostTransactionResult } from './postTransaction.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new InvalidFieldError(field, 'must be a UUID');
  }
}

/**
 * Greedy, deterministic reversal of what is still outstanding on a payment.
 *
 * `outstanding[acct]` is the account's net movement across the payment's
 * capture and refund transactions. Positive means the account is still
 * debited by the payment; negative means it is still credited.
 * - Accounts with outstanding > 0 are credited (negative entries), ascending
 *   by account id, each up to its outstanding, until `amount` is used.
 * - Accounts with outstanding < 0 are debited (positive entries), ascending
 *   by account id, each up to its absolute outstanding, until `amount` is used.
 * Zero legs are omitted. The result sums to 0n; nothing is rounded.
 * Throws if either side cannot absorb `amount` (inconsistent data), rather
 * than returning a partial reversal.
 */
export function allocateRefund(
  outstanding: ReadonlyMap<string, bigint>,
  amount: bigint,
): { accountId: string; amount: bigint }[] {
  if (amount <= 0n) throw new InvalidRefundAmountError(amount);
  const ids = [...outstanding.keys()].sort();

  const allocate = (sign: 1n | -1n): { accountId: string; amount: bigint }[] => {
    const legs: { accountId: string; amount: bigint }[] = [];
    let left = amount;
    for (const id of ids) {
      if (left === 0n) break;
      const o = outstanding.get(id)! * sign; // > 0 when this side applies
      if (o <= 0n) continue;
      const take = o < left ? o : left;
      legs.push({ accountId: id, amount: -sign * take });
      left -= take;
    }
    if (left !== 0n) {
      throw new Error(
        `Cannot allocate refund of ${amount}: ${left} not reversible on the ${sign === 1n ? 'debit' : 'credit'} side`,
      );
    }
    return legs;
  };

  return [...allocate(1n), ...allocate(-1n)];
}

/**
 * Refunds `amount` of a captured payment, atomically and idempotently.
 *
 * Lock order (global, deterministic; every path acquires in this order):
 *   1. the idempotency key row (claimed first, so a replay of a completed
 *      refund returns the stored response before any cap check runs),
 *   2. the payment's transaction rows (capture + refund), ORDER BY id,
 *   3. account rows ORDER BY account_id (taken inside postTransaction).
 * Plain postTransaction only takes locks of kind 3 (after its own key claim),
 * so no lock cycle is possible.
 *
 * Known limitation: a payment's first refund inserts a new refund row that a
 * concurrent refund cannot have locked. Serialization still holds because both
 * refunds lock the same capture rows (step 2) before computing the cap, so the
 * second waits until the first commits, then reads its refund row.
 *
 * The postTransaction callerTx path skips the request-hash check and the
 * `completed` update, so this function does both itself when it owns the
 * transaction.
 *
 * Optional `callerTx`: an open Drizzle transaction owned by the caller (used by
 * the webhook handler). In that mode this function does NOT open a
 * transaction, hash the request, claim the key, resolve existing keys, or mark
 * the record `completed`. Contract, mirroring `postTransaction`: the caller
 * must already have claimed `idempotencyKey` on the same `callerTx` (the
 * refund's `transactions.idempotency_key` is a foreign key to it), and the
 * caller is responsible for the request-hash check and for setting the final
 * `completed` status. Validation, the payment-row locks, the cap check, the
 * allocation and the entry writes all still run, on `callerTx`. A
 * `RefundCapExceededError` leaves `callerTx` open; wrap the call in a savepoint
 * (`callerTx.transaction(...)`) to roll back only the refund's own work.
 */
export async function refund(
  db: Db,
  input: RefundInput,
  callerTx?: Tx,
): Promise<PostTransactionResult> {
  const { idempotencyKey, paymentId, amount } = (input ?? {}) as Partial<RefundInput>;

  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '') {
    throw new MissingIdempotencyKeyError();
  }
  assertUuid('idempotencyKey', idempotencyKey);
  if (paymentId === undefined || paymentId === null || paymentId === '') {
    throw new MissingFieldError('paymentId');
  }
  assertUuid('paymentId', paymentId);
  if (typeof amount !== 'bigint') throw new InvalidFieldError('amount', 'must be a bigint');
  if (amount <= 0n) throw new InvalidRefundAmountError(amount);

  const pid = paymentId.toLowerCase();

  // Caller-owned transaction: the caller has already claimed the key.
  if (callerTx) return refundOnTx(callerTx, db, pid, amount, idempotencyKey);

  // `op` keeps a refund request from ever hashing like a postTransaction payload.
  const requestHash = hashPayload({ op: 'refund', paymentId: pid, amount });

  return db.transaction(async (tx) => {
    const claim = await claimOrReplay(tx, idempotencyKey, requestHash);
    if (!claim.claimed) return claim.response;

    const response = await refundOnTx(tx, db, pid, amount, idempotencyKey);
    await completeKey(tx, idempotencyKey, response);
    return response;
  });
}

/**
 * The refund itself, on whatever transaction it is given: lock the payment's
 * capture and refund rows, compute the cap, allocate, and post. Assumes the
 * idempotency key is already claimed on `tx`. Does not mark it completed.
 */
async function refundOnTx(
  tx: Tx,
  db: Db,
  pid: string,
  amount: bigint,
  idempotencyKey: string,
): Promise<PostTransactionResult> {
  const locked = await tx
    .select({ id: transactions.id, kind: transactions.kind })
    .from(transactions)
    .where(and(eq(transactions.paymentId, pid), inArray(transactions.kind, ['capture', 'refund'])))
    .orderBy(asc(transactions.id))
    .for('update');
  if (!locked.some((t) => t.kind === 'capture')) throw new PaymentNotFoundError(pid);

  // New statement after the locks: sees everything committed by prior lock holders.
  const rows = await tx
    .select({
      kind: transactions.kind,
      accountId: entries.accountId,
      net: sql<string>`sum(${entries.amount})::text`,
      positive: sql<string>`coalesce(sum(case when ${entries.amount} > 0 then ${entries.amount} else 0 end), 0)::text`,
    })
    .from(entries)
    .innerJoin(transactions, eq(entries.transactionId, transactions.id))
    .where(and(eq(transactions.paymentId, pid), inArray(transactions.kind, ['capture', 'refund'])))
    .groupBy(transactions.kind, entries.accountId);

  let captured = 0n;
  let alreadyRefunded = 0n;
  const outstanding = new Map<string, bigint>();
  for (const r of rows) {
    if (r.kind === 'capture') captured += BigInt(r.positive);
    else alreadyRefunded += BigInt(r.positive);
    outstanding.set(r.accountId, (outstanding.get(r.accountId) ?? 0n) + BigInt(r.net));
  }

  const remaining = captured - alreadyRefunded;
  if (amount > remaining) throw new RefundCapExceededError(amount, remaining);

  return postTransaction(
    db,
    {
      idempotencyKey,
      kind: 'refund',
      paymentId: pid,
      entries: allocateRefund(outstanding, amount),
    },
    tx,
  );
}
