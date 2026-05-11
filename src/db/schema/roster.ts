import { type AnyPgColumn, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brokerages } from './brokerages';
import { customers } from './customers';
import { onboardingStatusEnum } from './enums';

// Mirrors RosterAgent interface in src/types/index.ts.
//
// Post-DMG-roster-plan, this table holds the verified-and-started-onboarding
// bridge row only — the one-time-copy audit row showing what we copied from
// DMG into a Customer at time T. Bulk B2B roster lives in roster_agents
// (DMG plan §3.1). FK to customers added in 0002 migration.

export const roster = pgTable('roster', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  brokerageId: uuid('brokerage_id').references(() => brokerages.id, { onDelete: 'set null' }),
  agentName: text('agent_name'),
  phone: text('phone'),
  licenseNumber: text('license_number'),
  website: text('website'),
  photoUrl: text('photo_url'),                                            // Vercel Blob URL post-Phase 4
  logoUrl: text('logo_url'),
  bio: text('bio'),
  serviceAreas: text('service_areas'),
  mlsIds: text('mls_ids'),
  topics: text('topics'),
  hashtags: text('hashtags'),
  gmbName: text('gmb_name'),
  otherEmails: text('other_emails'),
  onboardingStatus: onboardingStatusEnum('onboarding_status').notNull().default('Not Started'),
  customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'set null' }),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RosterRow = typeof roster.$inferSelect;
export type NewRosterRow = typeof roster.$inferInsert;
