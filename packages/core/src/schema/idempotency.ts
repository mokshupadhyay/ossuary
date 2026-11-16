import { pgTable, pgEnum, uuid, text, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const idempotencyStatus = pgEnum('idempotency_status', ['in_progress', 'completed']);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: uuid('key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idempotency_records_key_idx').on(table.key)],
);
