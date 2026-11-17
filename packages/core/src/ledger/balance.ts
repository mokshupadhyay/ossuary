import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AccountNotFoundError, InvalidFieldError, MissingFieldError } from '../errors/index.js';
import { accounts, entries } from '../schema/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live balance of an account: the signed sum of its entries, derived at read
 * time. Throws `AccountNotFoundError` for an unknown account. No transaction
 * wrapper, no cache, no stored balance.
 */
export async function balance(db: Db, accountId: string): Promise<bigint> {
  if (accountId === undefined || accountId === null || accountId === '') {
    throw new MissingFieldError('accountId');
  }
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
    throw new InvalidFieldError('accountId', 'must be a UUID');
  }
  const id = accountId.toLowerCase();

  const found = await db
    .select({ accountId: accounts.accountId })
    .from(accounts)
    .where(eq(accounts.accountId, id))
    .limit(1);
  if (found.length === 0) throw new AccountNotFoundError(id);

  // Cast to text in SQL so the value never passes through a JS Number.
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${entries.amount}), 0)::text` })
    .from(entries)
    .where(eq(entries.accountId, id));
  return BigInt(row?.total ?? '0');
}
