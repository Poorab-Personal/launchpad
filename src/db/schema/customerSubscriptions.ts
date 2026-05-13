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
import { productEnum, subscriptionStatusEnum } from './enums';

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
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    hubspotDealId: text('hubspot_deal_id'),                                       // same across all subs for one customer
    status: subscriptionStatusEnum('status'),                                     // mirrors Stripe sub status
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    mrr: numeric('mrr'),                                                          // cents (string for precision)

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
    stripeSubscriptionUnique: uniqueIndex('customer_subscriptions_stripe_subscription_unique').on(
      table.stripeSubscriptionId,
    ),
    customerIdx: index('customer_subscriptions_customer_idx').on(table.customerId),
    hubspotDealIdx: index('customer_subscriptions_hubspot_deal_idx').on(table.hubspotDealId),
  }),
);

export type CustomerSubscription = typeof customerSubscriptions.$inferSelect;
export type NewCustomerSubscription = typeof customerSubscriptions.$inferInsert;
