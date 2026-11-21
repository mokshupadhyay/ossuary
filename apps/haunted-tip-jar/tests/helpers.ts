import { sql } from 'drizzle-orm';
import { createAccount } from '@ossuary/core';
import { fakeClock, type FakeClock } from '@ossuary/core/poltergeist';
import type { Db } from '../src/db';
import type { JarRef } from '../src/rail';

/** 2026-10-31T20:00:00Z: a stream on Halloween. */
export const T0_MS = Date.UTC(2026, 9, 31, 20);

export const newClock = (): FakeClock => fakeClock(T0_MS);
export const uuid = (): string => globalThis.crypto.randomUUID();

/** A bare jar row with fresh core accounts. Shares the database with other jars. */
export async function bareJar(db: Db): Promise<JarRef> {
  const id = uuid();
  const jarAccountId = uuid();
  const clearingAccountId = uuid();
  await createAccount(db, { accountId: jarAccountId, name: `test jar ${id}`, type: 'revenue' });
  await createAccount(db, { accountId: clearingAccountId, name: `test clearing ${id}`, type: 'asset', allowOverdraft: true });
  const railSecret = 'test-rail-secret-'.padEnd(64, 'x');
  await db.execute(sql`
    INSERT INTO tipjar_jars (id, creator, goal, jar_account_id, clearing_account_id, rail_secret)
    VALUES (${id}, 'Test creator', ${100_000_000n}, ${jarAccountId}, ${clearingAccountId}, ${railSecret})`);
  return { id, jarAccountId, clearingAccountId, railSecret };
}

/** Sum of an account's entries, as bigint, from core's table. */
export async function entrySum(db: Db, accountId: string): Promise<bigint> {
  const r = await db.execute(sql`SELECT coalesce(sum(amount), 0)::text AS s FROM entries WHERE account_id = ${accountId}`);
  return BigInt(String(r.rows[0]!['s']));
}
