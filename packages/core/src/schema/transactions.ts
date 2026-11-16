import { pgTable, pgEnum, uuid, timestamp } from 'drizzle-orm/pg-core';
import { idempotencyRecords } from './idempotency.js';

export const transactionKind = pgEnum('transaction_kind', ['capture', 'refund', 'transfer']);

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey(),
  kind: transactionKind('kind').notNull(),
  paymentId: uuid('payment_id'),
  idempotencyKey: uuid('idempotency_key').references(() => idempotencyRecords.key),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
