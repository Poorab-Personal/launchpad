/**
 * Daily-checks automation — surfaces three onboarding gaps so they
 * can't sit invisibly.
 *
 *  Section 1 — Stripe sub created in LP but NOT linked into Rejig.
 *    LP customer has stripeSubscriptionId (created by the ticket → Active
 *    webhook), but the Rejig account matched on email shows a different
 *    or null stripe_subscription_id. Surfaces:
 *      - rejig-sub-null         Rejig account exists, no sub linked
 *      - wrong-sub-linked       Rejig has a different sub id (rare)
 *      - no-rejig-account       no Rejig account found for LP's emails
 *      - multiple-rejig-accounts ambiguous match — manual review
 *
 *  Section 2 — CSM didn't mark the onboarding meeting outcome.
 *    B2B customer still in 'Onboarding Scheduled' more than 18h after
 *    callDate. The HubSpot ticket-stage flip never fired, so the trial
 *    Stripe subscription was never created. Re-flags each day until
 *    resolved. Excludes billing_relationship in ('comped','internal_demo')
 *    — those legitimately don't need a Stripe sub.
 *
 *  Section 3 — a brokerage roster has gone stale.
 *    brokerages.last_roster_sync older than STALE_ROSTER_DAYS. The sync is
 *    weekly, so anything past 8 days means at least one run was missed and
 *    the landing page is turning away agents who joined since — exactly the
 *    2026-08-14 Keyes incident, where the roster sat 32 days stale and a
 *    real agent (Deborah Dietz) hit "we don't see you in this brokerage's
 *    roster". That went unnoticed for a month because a maxDuration kill
 *    terminates the process instead of throwing, so no 'Roster Sync Failed'
 *    event is ever written. Timestamp staleness is the only reliable signal.
 *
 * Sections 1 and 2 filter to createdAt >= DIGEST_CUTOFF_DATE so legacy
 * pilots created before this surfacing system was introduced don't
 * false-positive. Section 3 is brokerage-level and has no such cutoff.
 *
 * No DB writes. State is derived per run: if the gap persists, the row
 * resurfaces tomorrow; once fixed, it drops. No "mark done" tracking
 * needed.
 */
import { and, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db } from '@/db';
import { brokerages } from '@/db/schema/brokerages';
import { customers } from '@/db/schema/customers';
import { fetchAccountsSnapshot, type RejigAccount } from '@/lib/integrations/rejig/client';

/**
 * Anchor date for surfacing — anything created before this is grandfathered
 * out (legacy pilots, comp accounts predating the new digest). UTC midnight
 * of the chosen rollout day.
 *
 * Set to 2026-06-01 (not the rollout day itself) so the first wave of
 * currently-in-flight B2B customers — created on brokerage landing pages
 * in early June, with onboarding meetings scheduled mid-June — are inside
 * the surfacing window. Tied to created_at on `customers`.
 */
export const DIGEST_CUTOFF_DATE = new Date('2026-06-01T00:00:00Z');

const EIGHTEEN_HOURS_MS = 18 * 60 * 60 * 1000;

export type Section1Reason =
  | 'rejig-sub-null'
  | 'wrong-sub-linked'
  | 'no-rejig-account'
  | 'multiple-rejig-accounts';

export type Section1Row = {
  customerId: string;
  customerName: string;
  contactEmail: string;
  platformEmail: string;
  workflowKey: string;
  hubspotTicketId: string | null;
  lpStripeSubId: string;
  rejigStripeSubId: string | null;
  reason: Section1Reason;
};

export type Section2Row = {
  customerId: string;
  customerName: string;
  contactEmail: string;
  platformEmail: string;
  workflowKey: string;
  brokerageName: string | null;
  hubspotTicketId: string | null;
  callDate: Date;
};

export type Section3Row = {
  brokerageId: string;
  brokerageName: string;
  landingPageSlug: string;
  lastRosterSync: Date | null;
  daysStale: number | null; // null when never synced
};

export type DailyChecksResult = {
  section1: Section1Row[];
  section2: Section2Row[];
  section3: Section3Row[];
  /**
   * Per-section failures, e.g. `"section1: Rejig API 524"`. A section that
   * throws yields [] rather than aborting the run — see runDailyChecks.
   */
  sectionErrors: string[];
  rejigAccountsFetched: number;
  durationMs: number;
};

/**
 * Staleness threshold for section 3. The roster cron is weekly, so 8 days
 * means a scheduled run was missed rather than merely being mid-week. Note
 * Hobby crons fire within the hour of their scheduled time, so the extra day
 * of slack also absorbs that jitter without flapping.
 */
const STALE_ROSTER_DAYS = 8;

/**
 * Section 3 — active brokerages whose roster hasn't synced inside the
 * weekly cadence. A NULL last_roster_sync (never synced at all) also
 * surfaces, sorted first, with daysStale = null.
 */
async function runSection3(): Promise<Section3Row[]> {
  const cutoff = new Date(Date.now() - STALE_ROSTER_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      brokerageId: brokerages.id,
      brokerageName: brokerages.name,
      landingPageSlug: brokerages.landingPageSlug,
      lastRosterSync: brokerages.lastRosterSync,
    })
    .from(brokerages)
    .where(
      and(
        eq(brokerages.active, true),
        isNotNull(brokerages.sourceType),
        or(
          isNull(brokerages.lastRosterSync),
          lt(brokerages.lastRosterSync, cutoff),
        ),
      ),
    );

  return rows
    .map((r) => ({
      ...r,
      daysStale: r.lastRosterSync
        ? Math.floor((Date.now() - r.lastRosterSync.getTime()) / (24 * 60 * 60 * 1000))
        : null,
    }))
    // Never-synced first, then most-stale first.
    .sort((a, b) => (b.daysStale ?? Infinity) - (a.daysStale ?? Infinity));
}

/**
 * Run all three gap-detection sections. Caller decides whether to send the
 * digest email (skip when every section is empty).
 *
 * `allSettled`, deliberately — NOT `all`. The sections are independent, and
 * section 1 depends on the external Rejig API, which does time out (observed
 * 524 on 2026-08-14). Under `Promise.all` that one upstream outage blanked
 * the entire digest, including the section-3 roster-staleness check. Since
 * section 3 exists precisely to make silent breakage visible, letting an
 * unrelated API hiccup suppress it would defeat the point. A failing section
 * degrades to [] and records the reason in `sectionErrors`.
 */
export async function runDailyChecks(): Promise<DailyChecksResult> {
  const t0 = Date.now();
  const [s1, s2, s3] = await Promise.allSettled([
    runSection1(),
    runSection2(),
    runSection3(),
  ]);

  const sectionErrors: string[] = [];
  const reason = (r: PromiseRejectedResult) =>
    r.reason instanceof Error ? r.reason.message : String(r.reason);

  if (s1.status === 'rejected') sectionErrors.push(`section1: ${reason(s1)}`);
  if (s2.status === 'rejected') sectionErrors.push(`section2: ${reason(s2)}`);
  if (s3.status === 'rejected') sectionErrors.push(`section3: ${reason(s3)}`);
  for (const e of sectionErrors) console.error(`[daily-checks] ${e}`);

  return {
    section1: s1.status === 'fulfilled' ? s1.value.rows : [],
    section2: s2.status === 'fulfilled' ? s2.value : [],
    section3: s3.status === 'fulfilled' ? s3.value : [],
    sectionErrors,
    rejigAccountsFetched:
      s1.status === 'fulfilled' ? s1.value.rejigAccountsFetched : 0,
    durationMs: Date.now() - t0,
  };
}

async function runSection1(): Promise<{ rows: Section1Row[]; rejigAccountsFetched: number }> {
  // 1. Pull Rejig snapshot into memory (no persistence — that stays weekly).
  const rejigAccounts = await fetchAccountsSnapshot();

  // 2. Build email → Rejig account(s) index. Mirrors the matcher in
  //    src/lib/integrations/rejig/import.ts:196-238 (lowercase + trim).
  //    Kept inline rather than extracted so this module is self-contained
  //    and the ingest pipeline isn't touched.
  const rejigByEmail = new Map<string, RejigAccount[]>();
  for (const acc of rejigAccounts) {
    const key = (acc.email ?? '').trim().toLowerCase();
    if (!key) continue;
    const arr = rejigByEmail.get(key) ?? [];
    arr.push(acc);
    rejigByEmail.set(key, arr);
  }

  // 3. Candidate LP customers — created after rollout, with both a Stripe
  //    sub id (auto-set by the ticket → Active webhook) AND a selected
  //    price (proof this customer was on a paid plan). selectedStripePriceId
  //    being NULL is the signal that this customer was never on a paid
  //    workflow (e.g. comp / demo / pilot path).
  const candidates = await db
    .select({
      id: customers.id,
      name: customers.name,
      contactEmail: customers.contactEmail,
      platformEmail: customers.platformEmail,
      workflowKey: customers.workflowKey,
      hubspotTicketId: customers.hubspotTicketId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .where(
      and(
        gte(customers.createdAt, DIGEST_CUTOFF_DATE),
        isNotNull(customers.stripeSubscriptionId),
        isNotNull(customers.selectedStripePriceId),
      ),
    );

  // 4. Compare each candidate against Rejig.
  const rows: Section1Row[] = [];
  for (const c of candidates) {
    const lpSub = c.stripeSubscriptionId;
    if (!lpSub) continue; // satisfies TS; isNotNull above already filtered

    const emails = [c.contactEmail, c.platformEmail]
      .map((e) => e?.trim().toLowerCase() ?? '')
      .filter((e): e is string => e.length > 0);

    // Collect unique Rejig matches across both LP emails.
    const seen = new Set<string>();
    const matched: RejigAccount[] = [];
    for (const e of emails) {
      for (const a of rejigByEmail.get(e) ?? []) {
        if (seen.has(a._id)) continue;
        seen.add(a._id);
        matched.push(a);
      }
    }

    const base = {
      customerId: c.id,
      customerName: c.name,
      contactEmail: c.contactEmail,
      platformEmail: c.platformEmail,
      workflowKey: c.workflowKey,
      hubspotTicketId: c.hubspotTicketId,
      lpStripeSubId: lpSub,
    };

    if (matched.length === 0) {
      rows.push({ ...base, rejigStripeSubId: null, reason: 'no-rejig-account' });
      continue;
    }
    if (matched.length > 1) {
      rows.push({ ...base, rejigStripeSubId: null, reason: 'multiple-rejig-accounts' });
      continue;
    }

    const rejig = matched[0];
    if (rejig.stripe_subscription_id === lpSub) {
      continue; // linked correctly — skip
    }
    rows.push({
      ...base,
      rejigStripeSubId: rejig.stripe_subscription_id,
      reason: rejig.stripe_subscription_id ? 'wrong-sub-linked' : 'rejig-sub-null',
    });
  }

  return { rows, rejigAccountsFetched: rejigAccounts.length };
}

async function runSection2(): Promise<Section2Row[]> {
  const cutoff = new Date(Date.now() - EIGHTEEN_HOURS_MS);

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      contactEmail: customers.contactEmail,
      platformEmail: customers.platformEmail,
      workflowKey: customers.workflowKey,
      hubspotTicketId: customers.hubspotTicketId,
      callDate: customers.callDate,
      brokerageName: brokerages.name,
    })
    .from(customers)
    .leftJoin(brokerages, eq(customers.brokerageId, brokerages.id))
    .where(
      and(
        gte(customers.createdAt, DIGEST_CUTOFF_DATE),
        eq(customers.type, 'B2B'),
        eq(customers.onboardingState, 'Onboarding Scheduled'),
        isNotNull(customers.callDate),
        lt(customers.callDate, cutoff),
        // Include 'paying' and NULL (legacy default); exclude comped + internal_demo.
        // NULL handling: ne() against NULL is NULL in SQL, which excludes the row —
        // that's why we OR explicitly with isNull().
        or(
          eq(customers.billingRelationship, 'paying'),
          isNull(customers.billingRelationship),
        ),
      ),
    );

  return rows
    .filter((r): r is typeof r & { callDate: Date } => r.callDate !== null)
    .map((r) => ({
      customerId: r.id,
      customerName: r.name,
      contactEmail: r.contactEmail,
      platformEmail: r.platformEmail,
      workflowKey: r.workflowKey,
      brokerageName: r.brokerageName,
      hubspotTicketId: r.hubspotTicketId,
      callDate: r.callDate,
    }));
}
