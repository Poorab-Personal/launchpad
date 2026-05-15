/**
 * Canonical signal_type strings for customer_usage_signals.signal_type.
 * Pass 2.7 §29: 12 v1 types (8 Stripe + 4 Rejig + 0 derived in v1 — the
 * `derived.posting_trajectory` is written by trajectory-job but not in
 * the const list since it's an internal output, not an ingest type).
 *
 * `intercom.*` types from Pass 2.6 §23.2 are DEFERRED — kept here as
 * commented future additions for visibility, NOT exported.
 */

export const SIGNAL_TYPES = {
  // === Stripe (event-driven via webhook, already live since Phase 2.5) ===
  STRIPE_SUBSCRIPTION_CREATED:        'stripe.subscription.created',
  STRIPE_SUBSCRIPTION_UPDATED:        'stripe.subscription.updated',
  STRIPE_SUBSCRIPTION_CANCELLED:      'stripe.subscription.cancelled',
  STRIPE_SUBSCRIPTION_TRIAL_WILL_END: 'stripe.subscription.trial_will_end',
  STRIPE_INVOICE_PAYMENT_SUCCEEDED:   'stripe.invoice.payment_succeeded',
  STRIPE_INVOICE_PAYMENT_FAILED:      'stripe.invoice.payment_failed',
  STRIPE_SETUP_INTENT_SUCCEEDED:      'stripe.setup_intent.succeeded',

  // === Rejig (weekly snapshot via Phase 5 importer / Phase 9 cron) ===
  REJIG_LAST_LOGIN:                   'rejig.last_login',
  REJIG_DAYS_SINCE_LAST_POST:         'rejig.days_since_last_post',
  REJIG_TOTAL_PUBLISHED_POSTS:        'rejig.total_published_posts',
  REJIG_LISTING_COUNT:                'rejig.listing_count',
  REJIG_DAYS_UNTIL_EXPIRY:            'rejig.days_until_expiry',
  REJIG_ACCOUNT_ACTIVE:               'rejig.account_active',

  // === Derived (computed by BI cron jobs, written for downstream consumers) ===
  DERIVED_POSTING_TRAJECTORY:         'derived.posting_trajectory',
  DERIVED_ACTION_FIRED:               'derived.action_fired',

  // === DEFERRED — Pass 2.6 §23.2 / Pass 2.7 §29.3 ===
  // INTERCOM_CONVERSATIONS_COUNT_30D: 'intercom.conversations_count_30d',
  // INTERCOM_LAST_CONTACT_AT:          'intercom.last_contact_at',
  // INTERCOM_UNRESOLVED_THREADS:      'intercom.unresolved_threads',
  // INTERCOM_FIRST_CONTACT_AT:        'intercom.first_contact_at',
} as const;

export type SignalType = (typeof SIGNAL_TYPES)[keyof typeof SIGNAL_TYPES];

/**
 * The 'source' column on customer_usage_signals. Pass 2 §6.1 vocabulary.
 */
export const SIGNAL_SOURCES = {
  STRIPE_WEBHOOK:        'stripe_webhook',
  REJIG_API:             'rejig_api',
  REJIG_FILE_SNAPSHOT:   'rejig_file_snapshot',  // legacy; only CSV-era. Kept for back-compat reads.
  LP_TRAJECTORY_JOB:     'lp_trajectory_job',
  LP_EVENT:              'lp_event',
} as const;

export type SignalSource = (typeof SIGNAL_SOURCES)[keyof typeof SIGNAL_SOURCES];
