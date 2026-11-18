import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { webhookEvents } from './webhookEvents.js';

export const outboxStatus = pgEnum('outbox_status', ['pending', 'sent', 'dead']);

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey(),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    eventId: text('event_id')
      .notNull()
      .references(() => webhookEvents.eventId),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    status: outboxStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    claimToken: uuid('claim_token'),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbox_due_idx').on(t.status, t.nextAttemptAt)],
);
