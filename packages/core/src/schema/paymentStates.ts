import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { webhookEvents } from './webhookEvents.js';

export const paymentStatus = pgEnum('payment_status', ['pending', 'captured', 'refunded']);

export const paymentStates = pgTable('payment_states', {
  paymentId: uuid('payment_id').primaryKey(),
  status: paymentStatus('status'),
  capturedEventId: text('captured_event_id').references(() => webhookEvents.eventId),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
