import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';

/**
 * Append-only time-series of engagement + payment signals per customer.
 *
 * Writers (planned across phases):
 *   - Stripe webhook (Phase 2.5):       stripe.subscription.*, stripe.invoice.*
 *   - Rejig CSV snapshot import (Phase 5):  rejig.last_login, rejig.posts_published, etc.
 *   - Rejig live API cron (Phase 9):    same shape, daily ingestion
 *   - LP internal events (later):       lp.email_bounced, lp.portal_visited, etc.
 *
 * Tall-skinny schema (one row per signal capture) — chosen over wide
 * column-per-signal-type because:
 *   - New signal types come online over multiple phases without schema churn
 *   - Time-series math (rate-of-change, cohort comparisons) is the primary
 *     query pattern; tall-skinny indexes on (customer_id, signal_type,
 *     observed_at) cover it cleanly
 *   - Cardinality projection (~2.5M rows/year at 700 customers × 10
 *     signals/day) is well within Postgres territory with these indexes
 *
 * `observed_at` ≠ `ingested_at`: the former is when the signal was true
 * in the source system (Stripe event timestamp, Rejig snapshot date); the
 * latter is when LaunchPad captured it. BI rules MUST use observed_at —
 * never ingested_at — to avoid false-positive "stale" reads from delayed
 * snapshots.
 *
 * customer_id is nullable so that Rejig users without a matching LP
 * customer (Phase 8 super-set scenario) can still have signals captured;
 * Phase 6 identity mapping joins them later.
 */
export const customerUsageSignals = pgTable(
  'customer_usage_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .references(() => customers.id, { onDelete: 'cascade' }),
    rejigUserId: text('rejig_user_id'),                                             // Rejig's account id; matches customers.rejigAccountId when joined

    signalType: text('signal_type').notNull(),                                      // e.g. 'rejig.last_login', 'stripe.subscription.past_due'

    // Two value columns for query ergonomics:
    //   signal_value_numeric  — for rate-of-change math, comparisons, aggregations
    //                           (login counts, post counts, MRR amounts, days-since)
    //   signal_value_jsonb    — for richer context (Stripe invoice metadata,
    //                           Rejig content-type breakdown, etc.)
    // A given signal_type uses one OR the other, occasionally both.
    signalValueNumeric: numeric('signal_value_numeric'),
    signalValueJsonb: jsonb('signal_value_jsonb'),

    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),         // when the signal was true (per source system)
    source: text('source').notNull(),                                               // 'rejig_api' / 'rejig_csv_snapshot' / 'stripe_webhook' / 'lp_event'
    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),                                                                // when LP captured the signal
  },
  (table) => ({
    // Primary read pattern: "latest N signals of type X for customer Y" —
    // used by every BI rule eligibility check
    customerSignalObservedIdx: index('cus_customer_signal_observed_idx').on(
      table.customerId,
      table.signalType,
      table.observedAt,
    ),
    // Secondary: "all customers with this signal in the last N days" —
    // used by admin dashboards and BI cohort filters
    signalObservedIdx: index('cus_signal_observed_idx').on(
      table.signalType,
      table.observedAt,
    ),
    // For Phase 6 identity mapping + Phase 8 super-set ingestion: signals
    // for Rejig users without an LP customer row yet
    rejigUserSignalIdx: index('cus_rejig_user_signal_idx').on(
      table.rejigUserId,
      table.signalType,
    ),
  }),
);

export type CustomerUsageSignal = typeof customerUsageSignals.$inferSelect;
export type NewCustomerUsageSignal = typeof customerUsageSignals.$inferInsert;
