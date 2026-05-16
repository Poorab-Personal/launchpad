import { sql } from 'drizzle-orm';
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { paymentSourceEnum, productEnum, subscriptionStatusEnum } from './enums';

// 1:N customer ↔ Stripe subscription. One row per (customer, product) pair.
// Created by /api/webhooks/hubspot on Deal closedwon — handler reads the
// 3 sub_id properties from the Deal (`stripe_payment_id` for Core,
// `voice_stripe_payment_id` for Voice, `avatar_stripe_payment_id` for Avatar)
// and inserts one row per non-null value.
//
// `hubspot_deal_id` is denormalized here (same value across all subs for a
// customer) — saves a join for reverse-lookups when a Stripe webhook needs
// to find the originating Deal.
//
// The legacy single-value columns on `customers` (stripe_subscription_id,
// voice_stripe_id, avatar_stripe_id) remain populated for backwards-compat
// during the transition; this table is the new source of truth.

export const customerSubscriptions = pgTable(
  'customer_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    product: productEnum('product').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id'),                         // nullable: B&W and demos have no Stripe sub
    hubspotDealId: text('hubspot_deal_id'),                                       // same across all subs for one customer
    status: subscriptionStatusEnum('status'),                                     // mirrors Stripe sub status
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    mrr: numeric('mrr'),                                                          // cents (string for precision)

    // §18 — period + invoice tracking, uniform across cohorts
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),// Stripe: live billing cycle; B&W/demos: account creation
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),    // Stripe: live; B&W: start + 6mo; D2C-no-Stripe: Rejig plan_expiry_date
    currentPeriodStartSource: text('current_period_start_source'),                // 'stripe' | 'mongo_id' | 'rejig_expiry' | 'unparseable'
    lastInvoiceStatus: text('last_invoice_status'),                               // 'paid' | 'open' | 'uncollectible' | 'void'
    lastInvoiceUrl: text('last_invoice_url'),                                     // Stripe hosted_invoice_url
    paymentSource: paymentSourceEnum('payment_source'),                           // 'stripe' | 'invoice' | NULL (demo/unknown)

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    customerProductUnique: uniqueIndex('customer_subscriptions_customer_product_unique').on(
      table.customerId,
      table.product,
    ),
    // (stripe_subscription_id is NOT unique — 4 team subscriptions are shared
    // by 60 agents in real data: Keyes master, agentship.com agency, KW teams.
    // Dedup on retries is enforced by customer_subscriptions_customer_product_unique
    // above. Dropped in migration 0011.)
    customerIdx: index('customer_subscriptions_customer_idx').on(table.customerId),
    hubspotDealIdx: index('customer_subscriptions_hubspot_deal_idx').on(table.hubspotDealId),
    // Defensive index for BI cron renewal-window queries (e.g. days_until_expiry).
    currentPeriodEndIdx: index('idx_customer_subscriptions_current_period_end')
      .on(table.currentPeriodEnd)
      .where(sql`${table.currentPeriodEnd} IS NOT NULL`),
  }),
);

export type CustomerSubscription = typeof customerSubscriptions.$inferSelect;
export type NewCustomerSubscription = typeof customerSubscriptions.$inferInsert;
