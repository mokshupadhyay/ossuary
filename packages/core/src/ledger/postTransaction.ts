import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  DuplicateKeyError,
  IdempotencyWindowExpiredError,
  InsufficientEntriesError,
  InvalidFieldError,
  KeyInFlightError,
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

function parseStoredResponse(key: string, value: unknown): PostTransactionResult {
  const r = value as Partial<PostTransactionResult> | null;
  if (
    r === null ||
    typeof r !== 'object' ||
    typeof r.transactionId !== 'string' ||
    !Array.isArray(r.entryIds) ||
    !r.entryIds.every((id) => typeof id === 'string')
  ) {
    throw new Error(`Stored response for idempotency key ${key} is malformed`);
  }
  return { transactionId: r.transactionId, entryIds: r.entryIds };
}

/**
 * Called when the key claim inserted no row, i.e. the key already exists.
 * Writes nothing; it only reads and either returns the stored response or throws.
 *
 * Concurrency (Req 3.5): under READ COMMITTED, INSERT ... ON CONFLICT DO NOTHING
 * waits for a concurrent uncommitted insert of the same key. If that commits,
 * the claim returns no row and the SELECT below (a new statement snapshot) sees
 * the committed `completed` record. If it rolls back, our INSERT claims the key.
 * Claim and completion share one DB transaction, so a committed `in_progress`
 * row should never exist; KeyInFlightError is a defensive branch.
 */
async function resolveExistingKey(
  tx: Pick<Db, 'select'>,
  key: string,
  requestHash: string,
): Promise<PostTransactionResult> {
  const [existing] = await tx
    .select({
      requestHash: idempotencyRecords.requestHash,
      status: idempotencyRecords.status,
      response: idempotencyRecords.response,
      expired: sql<boolean>`${idempotencyRecords.createdAt} < now() - interval '24 hours'`,
    })
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key));

  if (!existing) {
    throw new Error(`Idempotency key ${key} conflicted on insert but no record was found`);
  }
  if (existing.requestHash !== requestHash) throw new DuplicateKeyError(key);
  if (existing.status === 'in_progress') throw new KeyInFlightError(key);
  if (existing.expired) throw new IdempotencyWindowExpiredError(key);
  return parseStoredResponse(key, existing.response);
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
      return resolveExistingKey(tx, idempotencyKey, requestHash);
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
