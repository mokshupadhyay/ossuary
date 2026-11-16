import { pgTable, uuid, bigint, timestamp } from 'drizzle-orm/pg-core';
import { transactions } from './transactions.js';
import { accounts } from './accounts.js';

export const entries = pgTable('entries', {
  id: uuid('id').primaryKey(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => transactions.id),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.accountId),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
