import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  InsufficientEntriesError,
  InvalidFieldError,
  MissingIdempotencyKeyError,
  UnbalancedTransactionError,
} from '../errors/index.js';
import { entries, idempotencyRecords, transactions } from '../schema/index.js';
import type { PostTransactionInput } from '../types/index.js';
import { hashPayload } from './hash.js';

export interface PostTransactionResult {
  transactionId: string;
  entryIds: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly string[] = ['capture', 'refund', 'transfer'];

function assertUuid(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new InvalidFieldError(field, 'must be a UUID');
  }
}

/**
 * Posts a balanced set of entries atomically, claiming the idempotency key in
 * the same database transaction. All validation runs before any DB call.
 * Zero-amount entries are allowed: they cannot unbalance a transaction.
 */
export async function postTransaction(
  db: Db,
  input: PostTransactionInput,
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

  const requestHash = hashPayload({
    entries: entryInputs.map((e) => ({ accountId: e.accountId, amount: e.amount })),
    kind,
    paymentId: paymentId ?? null,
  });

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(idempotencyRecords)
      .values({ key: idempotencyKey, requestHash, status: 'in_progress' })
      .onConflictDoNothing({ target: idempotencyRecords.key })
      .returning({ key: idempotencyRecords.key });

    if (claimed.length === 0) {
      // PLACEHOLDER: replay / conflict / in-flight handling is task 7.2.
      throw new Error('idempotency replay handling not implemented (task 7.2)');
    }

    const transactionId = randomUUID();
    await tx.insert(transactions).values({
      id: transactionId,
      kind,
      paymentId: paymentId ?? null,
      idempotencyKey,
    });

    const rows = entryInputs.map((e) => ({
      id: randomUUID(),
      transactionId,
      accountId: e.accountId,
      amount: e.amount,
    }));
    await tx.insert(entries).values(rows);

    const response: PostTransactionResult = {
      transactionId,
      entryIds: rows.map((r) => r.id),
    };
    await tx
      .update(idempotencyRecords)
      .set({ status: 'completed', response })
      .where(eq(idempotencyRecords.key, idempotencyKey));

    return response;
  });
}
