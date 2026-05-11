import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors Brokerage interface in src/types/index.ts.
//
// Note on rosterApiUrl/rosterApiKey/rosterRefreshInterval: these are
// Airtable-era fields that the DMG roster plan (docs/integrations/
// dmg-roster-plan.md) will deprecate or refactor. Kept here for clean port;
// DMG plan handles cleanup in its own follow-up.

export const brokerages = pgTable(
  'brokerages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    landingPageSlug: text('landing_page_slug').notNull(),                  // /b/[slug]
    defaultWorkflowKey: text('default_workflow_key').notNull(),
    rosterApiUrl: text('roster_api_url'),                                  // vestigial post-DMG plan
    rosterApiKey: text('roster_api_key'),                                  // vestigial post-DMG plan
    rosterRefreshInterval: text('roster_refresh_interval'),                // vestigial post-DMG plan
    lastRosterSync: timestamp('last_roster_sync', { withTimezone: true }),
    defaultCalendlyUrl: text('default_calendly_url'),
    billingContact: text('billing_contact'),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    includesVoice: boolean('includes_voice').notNull().default(false),
    includesAvatar: boolean('includes_avatar').notNull().default(false),
    pricingTagline: text('pricing_tagline'),                               // pricing-page subhead; supports {Name} substitution
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('brokerages_landing_page_slug_unique').on(table.landingPageSlug),
  }),
);

export type Brokerage = typeof brokerages.$inferSelect;
export type NewBrokerage = typeof brokerages.$inferInsert;
