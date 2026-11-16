import { pgTable, pgEnum, uuid, varchar, boolean, timestamp } from 'drizzle-orm/pg-core';

export const accountType = pgEnum('account_type', ['asset', 'liability', 'revenue', 'expense']);

export const accounts = pgTable('accounts', {
  accountId: uuid('account_id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  type: accountType('type').notNull(),
  allowOverdraft: boolean('allow_overdraft').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
