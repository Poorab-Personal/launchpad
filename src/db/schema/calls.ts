import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { callStatusEnum, callTypeEnum } from './enums';
import { teamMembers } from './teamMembers';

// Mirrors Call interface in src/types/index.ts.
// `calendly_event_uuid UNIQUE` enforces idempotency at the DB layer
// (previously implemented in app code; now the constraint catches it).

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title'),                                                  // free-form (e.g. "Onboarding — Sarah Test")
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    type: callTypeEnum('type').notNull(),
    scheduledDate: timestamp('scheduled_date', { withTimezone: true }).notNull(),
    status: callStatusEnum('status').notNull().default('Scheduled'),
    csmTeamMemberId: uuid('csm_team_member_id').references(() => teamMembers.id, { onDelete: 'set null' }),
    notes: text('notes'),
    recordingUrl: text('recording_url'),
    calendlyEventUuid: text('calendly_event_uuid'),                        // dedup key for webhook deliveries
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastModified: timestamp('last_modified', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    calendlyEventUuidUnique: uniqueIndex('calls_calendly_event_uuid_unique').on(table.calendlyEventUuid),
  }),
);

export type Call = typeof calls.$inferSelect;
export type NewCall = typeof calls.$inferInsert;
