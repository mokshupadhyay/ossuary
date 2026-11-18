import { sql } from 'drizzle-orm';
import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { transactions } from './transactions.js';

export const webhookEventStatus = pgEnum('webhook_event_status', [
  'applied',
  'parked',
  'ignored',
  'rejected',
]);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    eventId: text('event_id').primaryKey(),
    receivedSeq: bigint('received_seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull().unique(),
    type: text('type').notNull(),
    paymentId: uuid('payment_id').notNull(),
    amount: bigint('amount', { mode: 'bigint' }),
    asset: text('asset').notNull(),
    rawBody: text('raw_body').notNull(),
    status: webhookEventStatus('status').notNull(),
    rejectionReason: text('rejection_reason'),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => transactions.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [index('webhook_events_parked_idx').on(t.paymentId, t.receivedSeq).where(sql`status = 'parked'`)],
);
