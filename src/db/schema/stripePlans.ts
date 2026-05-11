import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors StripePlan interface in src/types/index.ts.
// Shipped in payment-mode Phase 1.2 (already live in Airtable; this is the
// port target). Per-workflow plan options the customer picks during
// Capture Payment Method.

export const stripePlans = pgTable(
  'stripe_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planName: text('plan_name').notNull(),
    workflowKey: text('workflow_key').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    active: boolean('active').notNull().default(true),
    description: text('description'),
    priceDisplay: text('price_display'),                                  // e.g. "$199"
    pricePeriod: text('price_period'),                                    // e.g. "/mo"
    billingDetail: text('billing_detail'),
    footnote: text('footnote'),
    highlight: text('highlight'),
    displayOrder: integer('display_order'),                               // nullable; falls back to plan_name alpha
  },
  (table) => ({
    workflowActiveIdx: index('stripe_plans_workflow_active_idx').on(table.workflowKey, table.active),
  }),
);

export type StripePlan = typeof stripePlans.$inferSelect;
export type NewStripePlan = typeof stripePlans.$inferInsert;
