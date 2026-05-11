import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { customerTypeEnum } from './enums';

// Channels lookup. Seals the "Baird & Warner" vs "BW" typo class flagged in
// DMG plan §3.3 — invalid channels can't be inserted at all because
// Customers.channel_id is a FK to this table.
//
// Three rows seeded by migration:
//   ('Standard',  'D2C Standard',   'D2C')
//   ('Keyes',     'Keyes',          'B2B')
//   ('BW',        'Baird & Warner', 'B2B')

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),               // 'Standard' | 'Keyes' | 'BW' — joined to Customer.type for workflow_key
    displayName: text('display_name').notNull(),
    customerType: customerTypeEnum('customer_type').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeUnique: uniqueIndex('channels_code_unique').on(table.code),
  }),
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
