/**
 * BiContext builder — assembles the per-customer signal context that
 * feeds the 5-layer evaluator pipeline (profile → trajectory → outcome →
 * action → state). One entry point: `buildBiContext(customerId)`.
 *
 * Reads:
 *   - `customers` row (subscription, HS anchors, onboarding mirror, tenure)
 *   - latest `customer_usage_signals` row per `rejig.*` signal type
 *   - latest `derived.posting_trajectory` signal (Layer 2 input — its
 *     `signal_value_jsonb` IS the TrajectorySnapshot)
 *   - latest Stripe-related signals for payment-state derivation
 *   - HubSpot Contact `onboarding_no_show_count` property (soft-fail to 0)
 *
 * Single-customer for v1 simplicity. With ~700 customers and weekly cadence
 * (Pass 2.7 §29.2) the BI cron handler can loop over customers calling this
 * one-at-a-time. v2 may bulk-fetch signals upfront; not yet needed.
 */
import { Client } from '@hubspot/api-client';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerSubscriptions } from '@/db/schema/customerSubscriptions';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import { SIGNAL_TYPES } from './signal-types';
import type { BiContext, TrajectorySnapshot } from './types';

const MS_PER_DAY = 86400000;

/**
 * Pull the latest signal of each requested type for one customer. Returns
 * a Map keyed by signal_type → row. Uses Postgres DISTINCT ON for
 * one-query efficiency.
 *
 * Note: Drizzle doesn't expose DISTINCT ON ergonomically, so we issue
 * one combined query, order by (signal_type, observed_at DESC), and
 * pick the first row per type client-side. With at most ~10 rows per
 * customer per type and the indexed (customer_id, signal_type, observed_at)
 * scan, this is cheap.
 */
async function latestSignalsByType(
  customerId: string,
  signalTypes: string[],
): Promise<
  Map<
    string,
    {
      observedAt: Date;
      signalValueNumeric: string | null;
      signalValueJsonb: unknown;
    }
  >
> {
  if (signalTypes.length === 0) return new Map();
  const rows = await db
    .select({
      signalType: customerUsageSignals.signalType,
      observedAt: customerUsageSignals.observedAt,
      signalValueNumeric: customerUsageSignals.signalValueNumeric,
      signalValueJsonb: customerUsageSignals.signalValueJsonb,
    })
    .from(customerUsageSignals)
    .where(
      and(
        eq(customerUsageSignals.customerId, customerId),
        inArray(customerUsageSignals.signalType, signalTypes),
      ),
    )
    .orderBy(desc(customerUsageSignals.observedAt));

  const byType = new Map<
    string,
    { observedAt: Date; signalValueNumeric: string | null; signalValueJsonb: unknown }
  >();
  for (const r of rows) {
    if (!byType.has(r.signalType)) {
      byType.set(r.signalType, {
        observedAt: r.observedAt,
        signalValueNumeric: r.signalValueNumeric,
        signalValueJsonb: r.signalValueJsonb,
      });
    }
  }
  return byType;
}

/**
 * Fetch the HS Contact's `onboarding_no_show_count` property. Soft-fail
 * to 0 on any error — BI shouldn't crash because a single HS read failed.
 * Uses an inline SDK call rather than adding to `hubspot/client.ts` (other
 * Wave-2 agents are touching that file).
 */
async function fetchOnboardingNoShowCount(contactId: string): Promise<number> {
  try {
    const token = process.env.HUBSPOT_STATIC_TOKEN;
    if (!token) return 0;
    const hs = new Client({ accessToken: token });
    const contact = await hs.crm.contacts.basicApi.getById(contactId, [
      'onboarding_no_show_count',
    ]);
    const raw = contact.properties?.onboarding_no_show_count;
    if (raw == null || raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bi-context] HS no-show-count fetch failed for ${contactId}: ${msg}`);
    return 0;
  }
}

/**
 * Assemble the full BiContext for one customer. Returns null if the
 * customer row doesn't exist.
 */
export async function buildBiContext(customerId: string): Promise<BiContext | null> {
  // 1. Customer row
  const customer = await db.query.customers.findFirst({
    where: eq(customers.id, customerId),
  });
  if (!customer) return null;

  // 2. Latest signal per rejig.* type (used for both engagement metrics
  //    and the Stripe-state pull below in one query)
  const allTypes = [
    SIGNAL_TYPES.REJIG_LAST_LOGIN,
    SIGNAL_TYPES.REJIG_DAYS_SINCE_LAST_POST,
    SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS,
    SIGNAL_TYPES.REJIG_LISTING_COUNT,
    SIGNAL_TYPES.REJIG_DAYS_UNTIL_EXPIRY,
    SIGNAL_TYPES.REJIG_ACCOUNT_ACTIVE,
    SIGNAL_TYPES.DERIVED_POSTING_TRAJECTORY,
    SIGNAL_TYPES.STRIPE_INVOICE_PAYMENT_FAILED,
    SIGNAL_TYPES.STRIPE_INVOICE_PAYMENT_SUCCEEDED,
    SIGNAL_TYPES.STRIPE_SUBSCRIPTION_UPDATED,
  ];
  const latest = await latestSignalsByType(customerId, allTypes);

  // === Rejig metrics ===
  const lastLoginSig = latest.get(SIGNAL_TYPES.REJIG_LAST_LOGIN);
  const lastLoginJsonb = (lastLoginSig?.signalValueJsonb as
    | { lastLoginISO?: string | null; never?: boolean }
    | undefined) ?? undefined;
  let lastLoginAt: Date | null = null;
  if (lastLoginJsonb?.lastLoginISO) {
    const d = new Date(lastLoginJsonb.lastLoginISO);
    if (!Number.isNaN(d.getTime())) lastLoginAt = d;
  } else if (lastLoginSig && lastLoginSig.signalValueNumeric != null && !lastLoginJsonb?.never) {
    // Fallback: trust the signal row's observed_at if jsonb missing the ISO.
    lastLoginAt = lastLoginSig.observedAt;
  }
  const now = new Date();
  const daysSinceLogin =
    lastLoginAt != null
      ? Math.max(0, Math.floor((now.getTime() - lastLoginAt.getTime()) / MS_PER_DAY))
      : null;

  const totalPostsSig = latest.get(SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS);
  const totalPostsJsonb = (totalPostsSig?.signalValueJsonb as
    | {
        videoPosts?: number;
        imagePosts?: number;
        contentTypeBreakdown?: Record<string, number>;
      }
    | undefined) ?? undefined;
  const totalPosts = totalPostsSig?.signalValueNumeric != null
    ? Number(totalPostsSig.signalValueNumeric)
    : 0;

  const daysSincePostSig = latest.get(SIGNAL_TYPES.REJIG_DAYS_SINCE_LAST_POST);
  const daysSinceLastPost = daysSincePostSig?.signalValueNumeric != null
    ? Number(daysSincePostSig.signalValueNumeric)
    : null;

  const listingSig = latest.get(SIGNAL_TYPES.REJIG_LISTING_COUNT);
  const listingCount = listingSig?.signalValueNumeric != null
    ? Number(listingSig.signalValueNumeric)
    : 0;

  const expirySig = latest.get(SIGNAL_TYPES.REJIG_DAYS_UNTIL_EXPIRY);
  const expiryJsonb = (expirySig?.signalValueJsonb as
    | { planKey?: string | null; isManual?: boolean }
    | undefined) ?? undefined;
  // §18 — days_until_expiry derivation: prefer customer_subscriptions.current_period_end
  // (Stripe-authoritative for paying customers; computed at backfill for B&W/demos).
  // Legacy fallback to rejig signal for pre-backfill customers or customers
  // whose customer_subscriptions row hasn't been written yet.
  let daysUntilExpiry: number | null = null;
  const coreSub = await db.query.customerSubscriptions.findFirst({
    where: and(
      eq(customerSubscriptions.customerId, customerId),
      eq(customerSubscriptions.product, 'Core'),
    ),
  });
  if (coreSub?.currentPeriodEnd) {
    daysUntilExpiry = Math.floor(
      (coreSub.currentPeriodEnd.getTime() - now.getTime()) / MS_PER_DAY,
    );
  } else if (expirySig?.signalValueNumeric != null) {
    daysUntilExpiry = Number(expirySig.signalValueNumeric);
  }

  // === Trajectory (Layer 2 output — may not exist on first BI run) ===
  const trajSig = latest.get(SIGNAL_TYPES.DERIVED_POSTING_TRAJECTORY);
  const trajectory = (trajSig?.signalValueJsonb as TrajectorySnapshot | undefined) ?? null;

  // === Stripe payment-state ===
  const failedSig = latest.get(SIGNAL_TYPES.STRIPE_INVOICE_PAYMENT_FAILED);
  const succeededSig = latest.get(SIGNAL_TYPES.STRIPE_INVOICE_PAYMENT_SUCCEEDED);
  const subUpdatedSig = latest.get(SIGNAL_TYPES.STRIPE_SUBSCRIPTION_UPDATED);
  const subUpdatedJsonb = (subUpdatedSig?.signalValueJsonb as
    | { stripeStatus?: string | null; mappedLPStatus?: string | null }
    | undefined) ?? undefined;

  // === HubSpot no-show-count (soft-fail) ===
  const onboardingNoShowCount = customer.hubspotContactId
    ? await fetchOnboardingNoShowCount(customer.hubspotContactId)
    : 0;

  // === Tenure ===
  const tenureDays = Math.max(
    0,
    Math.floor((now.getTime() - customer.createdAt.getTime()) / MS_PER_DAY),
  );

  // === Customer type ===
  const customerType: 'D2C' | 'B2B' = customer.type === 'B2B' ? 'B2B' : 'D2C';

  const context: BiContext = {
    customerId: customer.id,
    workflowKey: customer.workflowKey,
    customerType,
    subscriptionStatus: customer.subscriptionStatus ?? null,
    stripeSubscriptionId: customer.stripeSubscriptionId ?? null,
    hubspotTicketId: customer.hubspotTicketId ?? null,
    hubspotContactId: customer.hubspotContactId ?? null,
    currentOnboardingState: customer.onboardingState ?? null,
    currentAttentionReason: customer.attentionReason ?? null,
    // The `customers` table doesn't yet have a typed engagementProfile
    // column written (Phase 5b adds the property push). Until then we
    // expose `null` so evaluators don't read stale state.
    currentEngagementProfile: null,
    attentionSetAt: customer.attentionSetAt ?? null,
    stageEnteredAt: customer.stageEnteredAt ?? null,
    tenureDays,
    signals: {
      rejig: {
        lastLoginAt,
        daysSinceLogin,
        totalPosts,
        videoPosts: totalPostsJsonb?.videoPosts ?? 0,
        imagePosts: totalPostsJsonb?.imagePosts ?? 0,
        daysSinceLastPost,
        listingCount,
        daysUntilExpiry,
        contentTypeBreakdown: totalPostsJsonb?.contentTypeBreakdown ?? {},
        isManual: expiryJsonb?.isManual ?? false,
        planKey: expiryJsonb?.planKey ?? null,
      },
      stripe: {
        lastPaymentFailedAt: failedSig?.observedAt ?? null,
        lastPaymentSucceededAt: succeededSig?.observedAt ?? null,
        lastSubscriptionStatus: subUpdatedJsonb?.stripeStatus ?? null,
      },
      trajectory,
      hsContact: {
        onboardingNoShowCount,
      },
    },
  };

  return context;
}
