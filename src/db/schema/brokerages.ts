import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sourceTypeEnum, verificationModeEnum } from './enums';

// Mirrors Brokerage interface in src/types/index.ts.
//
// DMG roster integration plan implemented here:
// docs/integrations/dmg-roster-plan.md (§3.2 — column changes).

export const brokerages = pgTable(
  'brokerages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    landingPageSlug: text('landing_page_slug').notNull(),                  // /{slug}
    defaultWorkflowKey: text('default_workflow_key').notNull(),
    lastRosterSync: timestamp('last_roster_sync', { withTimezone: true }),
    defaultCalendlyUrl: text('default_calendly_url'),
    billingContact: text('billing_contact'),
    notes: text('notes'),
    // HubSpot Company ID for the brokerage's master record. Used by the B2B
    // intake HS push (POST /api/customers when type='B2B') to associate the
    // newly-created agent Contact + Ticket to the right brokerage Company.
    // Populated manually per brokerage (one-time). NULL means LP can't push
    // a Ticket for this brokerage's agents until the ID is set.
    hubspotCompanyId: text('hubspot_company_id'),
    active: boolean('active').notNull().default(true),
    includesVoice: boolean('includes_voice').notNull().default(false),
    includesAvatar: boolean('includes_avatar').notNull().default(false),
    pricingTagline: text('pricing_tagline'),                               // pricing-page subhead; supports {Name} substitution
    // brokerage's master logo URL; pre-pop default for agent's businessLogo at customer creation (download to Vercel Blob).
    masterLogoUrl: text('master_logo_url'),
    // DMG roster plan §3.2 — multi-source roster integration.
    sourceType: sourceTypeEnum('source_type').notNull().default('dmg'),    // discriminator for src/lib/roster/sources/* adapter
    sourceConfig: jsonb('source_config'),                                  // per-source bits (e.g. DMG env-var key prefix)
    verificationMode: verificationModeEnum('verification_mode').notNull().default('soft'),  // escape hatch — flip to 'magic_link_required' if abuse
    supportContactName: text('support_contact_name'),                      // shown on the "we don't see you" failure screen
    supportContactEmail: text('support_contact_email'),
    supportContactPhone: text('support_contact_phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('brokerages_landing_page_slug_unique').on(table.landingPageSlug),
  }),
);

export type Brokerage = typeof brokerages.$inferSelect;
export type NewBrokerage = typeof brokerages.$inferInsert;
