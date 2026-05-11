import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Key-value settings table. Reads on every email send (portal_base_url).
// Seed initial row: portal_base_url = 'https://launchpad-indol-ten.vercel.app'.

export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    description: text('description'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    keyUnique: uniqueIndex('settings_key_unique').on(table.key),
  }),
);

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
