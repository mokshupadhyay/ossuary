import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  AccountNotFoundError,
  DuplicateAccountError,
  InvalidAccountTypeError,
  InvalidFieldError,
  MissingFieldError,
} from '../errors/index.js';
import { accounts } from '../schema/index.js';
import type { Account, AccountType } from '../types/index.js';

export interface CreateAccountInput {
  accountId: string;
  name: string;
  type: AccountType;
  allowOverdraft?: boolean;
}

const ACCOUNT_TYPES: readonly string[] = ['asset', 'liability', 'revenue', 'expense'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 255;

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function assertUuid(accountId: unknown): asserts accountId is string {
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
    throw new InvalidFieldError('accountId', 'must be a UUID');
  }
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    accountId: row.accountId,
    name: row.name,
    type: row.type,
    allowOverdraft: row.allowOverdraft,
    createdAt: row.createdAt,
  };
}

/** Creates an account. Validates before any DB call; duplicates write nothing. */
export async function createAccount(db: Db, input: CreateAccountInput): Promise<Account> {
  const { accountId, name, type, allowOverdraft } = (input ?? {}) as Partial<CreateAccountInput>;

  if (isMissing(accountId)) throw new MissingFieldError('accountId');
  if (isMissing(name)) throw new MissingFieldError('name');
  if (isMissing(type)) throw new MissingFieldError('type');

  if (typeof type !== 'string' || !ACCOUNT_TYPES.includes(type)) {
    throw new InvalidAccountTypeError(String(type));
  }
  assertUuid(accountId);
  if (typeof name !== 'string') throw new InvalidFieldError('name', 'must be a string');
  // Postgres varchar(n) counts characters (code points), not UTF-16 units.
  const length = [...name].length;
  if (length > MAX_NAME_LENGTH) {
    throw new InvalidFieldError('name', `must be 1-${MAX_NAME_LENGTH} characters, got ${length}`);
  }
  if (allowOverdraft !== undefined && typeof allowOverdraft !== 'boolean') {
    throw new InvalidFieldError('allowOverdraft', 'must be a boolean');
  }

  const rows = await db
    .insert(accounts)
    .values({
      accountId,
      name,
      type: type as AccountType,
      allowOverdraft: allowOverdraft ?? false,
    })
    .onConflictDoNothing({ target: accounts.accountId })
    .returning();

  const row = rows[0];
  if (!row) throw new DuplicateAccountError(accountId);
  return toAccount(row);
}

/** Fetches an account by id; throws `AccountNotFoundError` when absent. */
export async function getAccount(db: Db, accountId: string): Promise<Account> {
  if (isMissing(accountId)) throw new MissingFieldError('accountId');
  assertUuid(accountId);
  const rows = await db.select().from(accounts).where(eq(accounts.accountId, accountId)).limit(1);
  const row = rows[0];
  if (!row) throw new AccountNotFoundError(accountId);
  return toAccount(row);
}
