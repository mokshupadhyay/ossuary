import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  AccountNotFoundError,
  DuplicateKeyError,
  IdempotencyWindowExpiredError,
  InsufficientEntriesError,
  InvalidFieldError,
  KeyInFlightError,
  MissingIdempotencyKeyError,
  NormalBalanceViolationError,
  UnbalancedTransactionError,
} from '../errors/index.js';
import { accounts, entries, idempotencyRecords, transactions } from '../schema/index.js';
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

  // Normalise once: Postgres stores UUIDs lowercase, so hashing, locking,
  // balance checks and inserts must all see the same canonical form.
  const normalized = entryInputs.map((e) => ({
    accountId: e.accountId.toLowerCase(),
    amount: e.amount,
  }));

  // Same for paymentId, so a retry in a different letter case is a replay.
  const normalizedPaymentId =
    paymentId !== undefined && paymentId !== null ? paymentId.toLowerCase() : null;

  const requestHash = hashPayload({
    entries: normalized,
    kind,
    paymentId: normalizedPaymentId,
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

    await enforceNormalBalances(tx, normalized);

    const transactionId = randomUUID();
    await tx.insert(transactions).values({
      id: transactionId,
      kind,
      paymentId: normalizedPaymentId,
      idempotencyKey,
    });

    const rows = normalized.map((e) => ({
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
