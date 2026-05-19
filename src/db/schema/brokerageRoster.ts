import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { brokerages } from './brokerages';
import { customers } from './customers';

/**
 * Bulk pre-verification roster — one row per agent per brokerage, periodically
 * synced from each brokerage's source via per-source adapters
 * (src/lib/roster/sources/<source>.ts). Multi-source from day one:
 * `brokerages.source_type` discriminates, the per-source adapter normalizes
 * the source's payload into this shape, the cron UPSERTs here.
 *
 * Distinct from the existing `roster` table — that one is the post-verification
 * one-row-per-onboarding-agent bridge. This one is the bulk reference table.
 *
 * See docs/integrations/dmg-roster-plan.md §3.1.
 *
 * Promotion rule (§3.1): a field is a column iff (a) we filter/sort on it
 * in SQL, (b) we read it on the hot path more than once, or (c) it maps into
 * a customers column at verification time. Everything else lives in
 * `source_data` only.
 *
 * `first_seen_at` ≠ `created_at`: first_seen_at is preserved across
 * soft-delete + reappearance cycles so "agents who joined the roster in the
 * last N days" nudge queries stay meaningful. created_at is set once when
 * the row is first written to this Postgres instance.
 */
export const brokerageRoster = pgTable(
  'brokerage_roster',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brokerageId: uuid('brokerage_id')
      .notNull()
      .references(() => brokerages.id, { onDelete: 'cascade' }),
    sourceUserId: text('source_user_id').notNull(),                        // stable id from the source (DMG userId today)
    accountType: text('account_type').notNull(),                           // always 'agent'; non-agents filtered at sync
    status: text('status'),                                                // source-specific status (active/inactive)
    displayName: text('display_name'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    publicEmail: text('public_email'),
    privateEmail: text('private_email'),
    cellPhone: text('cell_phone'),                                         // stored; NEVER used as an auth factor (TCPA)
    website: text('website'),
    license: text('license'),
    photoUrl: text('photo_url'),                                           // reference only; NOT copied to customers.agent_photo
    bio: text('bio'),
    mlsIds: text('mls_ids'),
    primaryOfficeId: text('primary_office_id'),
    officeName: text('office_name'),                                       // promoted: nudge queries group by office
    sourceData: jsonb('source_data').notNull(),                            // raw normalized payload
    sourceSchemaVersion: text('source_schema_version'),                    // forward-compat: which payload shape
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),  // set on verification
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),            // soft-delete: missing from latest sync
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalKeyUnique: uniqueIndex('brokerage_roster_natural_key_unique').on(
      table.brokerageId,
      table.sourceUserId,
    ),
    // Lookup path: lookupByEmail(brokerageId, email) — case-insensitive on
    // either email column, partial on alive rows. See plan §4.2 step 3.
    publicEmailIdx: index('idx_brokerage_roster_public_email')
      .on(sql`LOWER(${table.publicEmail})`, table.brokerageId)
      .where(sql`${table.deletedAt} IS NULL`),
    privateEmailIdx: index('idx_brokerage_roster_private_email')
      .on(sql`LOWER(${table.privateEmail})`, table.brokerageId)
      .where(sql`${table.deletedAt} IS NULL`),
    // Sales nudge queries: WHERE customer_id IS NULL AND deleted_at IS NULL.
    unboardedIdx: index('idx_brokerage_roster_unboarded')
      .on(table.brokerageId)
      .where(sql`${table.customerId} IS NULL AND ${table.deletedAt} IS NULL`),
  }),
);

export type BrokerageRoster = typeof brokerageRoster.$inferSelect;
export type NewBrokerageRoster = typeof brokerageRoster.$inferInsert;
