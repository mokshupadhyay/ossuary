import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  DuplicateKeyError,
  IdempotencyWindowExpiredError,
  KeyInFlightError,
} from '../errors/index.js';
import { idempotencyRecords } from '../schema/index.js';

/** The JSON-safe response stored on an idempotency record and returned on replay. */
export interface StoredResponse {
  transactionId: string;
  entryIds: string[];
}

export type ClaimResult = { claimed: true } | { claimed: false; response: StoredResponse };

function parseStoredResponse(key: string, value: unknown): StoredResponse {
  const r = value as Partial<StoredResponse> | null;
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
): Promise<StoredResponse> {
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
 * Claims `key` with `INSERT ... ON CONFLICT DO NOTHING RETURNING`. Returns
 * `{ claimed: true }` when this transaction now owns the key. Otherwise the key
 * already exists and the stored response is returned, or DuplicateKeyError,
 * KeyInFlightError or IdempotencyWindowExpiredError is thrown.
 */
export async function claimOrReplay(
  tx: Pick<Db, 'insert' | 'select'>,
  key: string,
  requestHash: string,
): Promise<ClaimResult> {
  const claimed = await tx
    .insert(idempotencyRecords)
    .values({ key, requestHash, status: 'in_progress' })
    .onConflictDoNothing({ target: idempotencyRecords.key })
    .returning({ key: idempotencyRecords.key });

  if (claimed.length > 0) return { claimed: true };
  return { claimed: false, response: await resolveExistingKey(tx, key, requestHash) };
}

/** Marks a claimed key completed and stores its response. */
export async function completeKey(
  tx: Pick<Db, 'update'>,
  key: string,
  response: StoredResponse,
): Promise<void> {
  await tx
    .update(idempotencyRecords)
    .set({ status: 'completed', response })
    .where(eq(idempotencyRecords.key, key));
}
