/**
 * GET /api/cron/bi
 *
 * Weekly BI cron — runs Monday 11:00 UTC via Vercel cron (see vercel.json).
 * Auth: Bearer ${CRON_SECRET} header (Vercel cron sends this automatically
 * when the env var is configured in the Vercel project).
 *
 * Per Pass 2.7 §29.2: weekly cadence (not daily) gives steady ticket states
 * for the Monday-morning CSM workflow. Stripe webhooks still drive real-time
 * payment-related state changes via `applyStateTransition` directly; this
 * cron handles engagement + trajectory + outcome-derived states.
 *
 * Flow:
 *   1. Auth check (Bearer CRON_SECRET).
 *   2. Refresh derived.posting_trajectory signals via
 *      computeTrajectoriesForAllCustomers() BEFORE BI evaluation.
 *   3. For each active customer (filter: onboardingState IS NOT NULL AND
 *      subscriptionStatus IS NOT NULL):
 *      a. buildBiContext(customerId) — assembles all 5 layers' inputs.
 *      b. classifyProfile(ctx) → EngagementProfile.
 *      c. ctx.signals.trajectory used directly (just refreshed in step 2);
 *         fall back to insufficient-data snapshot if null.
 *      d. RuleBasedOutcomePredictor.predict({profile, trajectory, ctx}).
 *      e. recommendAction(...) — may return null (no action template fired).
 *      f. mapToState(...) → {state, attentionReason, sourceDetail}.
 *      g. applyStateTransition({...changeSource:'lp_bi'}) — atomic LP write
 *         + best-effort HS Ticket stage push + rejig_attention_* property
 *         push (those last two handled inside applyStateTransition itself).
 *      h. Push Layer-1/3 metadata to the HS Contact (engagement profile,
 *         predicted outcome, last-login, days-since-last-post,
 *         days-until-expiry, posting trajectory).
 *      i. Push Layer-4 recommended-action properties to the HS Ticket
 *         (properties-only — Tier-B Task auto-creation deferred per
 *         Pass 2.7 §29.7 Q-2.5-4).
 *      j. Per-customer try/catch — one bad row never aborts the whole run.
 *   4. Return structured summary JSON for ops visibility.
 *
 * TODO (Phase 4-Polish): when `customers.engagementProfile` column lands
 * (Pass 2.5 §11.2 mirror), also persist the profile to LP DB here. For v1
 * the profile lives on the HS Contact only via rejig_engagement_profile.
 */
import type { NextRequest } from 'next/server';
import { and, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { applyStateTransition } from '@/lib/db';
import { buildBiContext } from '@/lib/bi/context';
import { classifyProfile } from '@/lib/bi/profile-classifier';
import {
  computeTrajectoriesForAllCustomers,
} from '@/lib/bi/trajectory-job';
import { RuleBasedOutcomePredictor } from '@/lib/bi/outcome-predictor';
import { recommendAction } from '@/lib/bi/action-recommender';
import { mapToState } from '@/lib/bi/state-mapper';
import {
  updateContactProperties,
  updateTicketProperties,
} from '@/lib/integrations/hubspot/client';
import type { TrajectorySnapshot } from '@/lib/bi/types';

/**
 * Default trajectory snapshot used when the context builder returns
 * `trajectory: null` (no derived row written yet for this customer).
 * Mirrors the shape detectTrajectoryPattern emits on N=0 input so the
 * downstream evaluators don't need a separate code path.
 */
function makeInsufficientDataSnapshot(): TrajectorySnapshot {
  return {
    pattern: 'insufficient_data',
    cyclesObserved: 0,
    currentPhase: 'flat',
    velocityHistory: [],
    loginHistory: [],
    snapshotsEvaluated: 0,
    firstDeclineObservedAt: null,
    lastRecoveryObservedAt: null,
    confidence: 'low',
  };
}

type ErrorRow = { customerId: string; message: string };

type BiCronSummary = {
  durationMs: number;
  trajectoriesComputed: { processed: number; written: number };
  customersEvaluated: number;
  stateTransitionsApplied: number;
  contactPropertiesWritten: number;
  ticketActionPropertiesWritten: number;
  ruleFireCounts: Record<string, number>;
  errors: ErrorRow[];
};

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json(
      { error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const t0 = Date.now();
  const summary: BiCronSummary = {
    durationMs: 0,
    trajectoriesComputed: { processed: 0, written: 0 },
    customersEvaluated: 0,
    stateTransitionsApplied: 0,
    contactPropertiesWritten: 0,
    ticketActionPropertiesWritten: 0,
    ruleFireCounts: {},
    errors: [],
  };

  // ─── Phase 1: refresh derived.posting_trajectory signals ──────────────
  // We deliberately run this BEFORE per-customer evaluation so each
  // buildBiContext() picks up the freshest trajectory snapshot in one
  // pass. Failures here don't abort the run — we'll fall back to whatever
  // trajectory rows already exist (or insufficient_data on first run).
  try {
    const traj = await computeTrajectoriesForAllCustomers();
    summary.trajectoriesComputed = {
      processed: traj.customersProcessed,
      written: traj.trajectoriesWritten,
    };
    for (const e of traj.errors) {
      summary.errors.push({
        customerId: e.customerId,
        message: `trajectory: ${e.error}`,
      });
    }
  } catch (err) {
    console.error('[BI cron] trajectory job failed (continuing with stale data)', err);
    summary.errors.push({
      customerId: 'GLOBAL',
      message: `trajectory: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ─── Phase 2: per-customer evaluation ─────────────────────────────────
  // Active filter: any customer with both onboardingState and subscriptionStatus
  // populated. Pre-launch customers (no subscriptionStatus yet) and stripped
  // legacy rows are skipped. This matches Pass 2.7 §29.2's "real customers"
  // scope; the trajectory job above is wider (ne(Cancelled)) on purpose so
  // we have history when these rows do become active.
  const activeCustomers = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        isNotNull(customers.onboardingState),
        isNotNull(customers.subscriptionStatus),
      ),
    );

  for (const c of activeCustomers) {
    try {
      const ctx = await buildBiContext(c.id);
      if (!ctx) continue;

      // Layer 1: Engagement Profile
      const profile = classifyProfile(ctx);
      bump(summary.ruleFireCounts, `profile:${profile}`);

      // Layer 2: Trajectory (already persisted by Phase 1 step above —
      // buildBiContext pulled the freshest signalValueJsonb into ctx)
      const trajectory = ctx.signals.trajectory ?? makeInsufficientDataSnapshot();
      bump(summary.ruleFireCounts, `trajectory:${trajectory.pattern}`);

      // Layer 3: Predicted Outcome
      const prediction = RuleBasedOutcomePredictor.predict({
        profile,
        trajectory,
        ctx,
      });
      bump(summary.ruleFireCounts, `outcome:${prediction.outcome}`);

      // Layer 4: Recommended Action (nullable)
      const action = recommendAction({
        profile,
        trajectory,
        outcome: prediction.outcome,
        ctx,
      });
      if (action) {
        bump(summary.ruleFireCounts, `action:${action.template.id}`);
      } else {
        bump(summary.ruleFireCounts, `action:none`);
      }

      // Layer 5: State Mapping
      const stateDecision = mapToState({
        profile,
        trajectory,
        outcome: prediction.outcome,
        ctx,
      });
      bump(summary.ruleFireCounts, `state:${stateDecision.state}`);

      // Atomic LP-side write + best-effort HS Ticket stage + rejig_attention_*
      // property push (applyStateTransition handles those last two internally).
      const transitionResult = await applyStateTransition({
        customerId: c.id,
        toState: stateDecision.state,
        attentionReason: stateDecision.attentionReason,
        changeSource: 'lp_bi',
        sourceDetail: stateDecision.sourceDetail,
        payload: {
          profile,
          outcome: prediction.outcome,
          outcomeConfidence: prediction.confidence,
          outcomeReasoning: prediction.reasoning,
          trajectoryPattern: trajectory.pattern,
          trajectoryConfidence: trajectory.confidence,
          actionTemplateId: action?.template.id ?? null,
        },
      });
      if (transitionResult.applied) summary.stateTransitionsApplied++;

      // TODO (Phase 4-Polish): once a `customers.engagement_profile` column
      // exists, mirror the classified profile to LP DB here. For v1 the
      // profile is surfaced only via the HS Contact property below.

      // ─── Push Layer-1 + Layer-3 metadata to HS Contact ────────────────
      if (ctx.hubspotContactId) {
        try {
          await updateContactProperties(ctx.hubspotContactId, {
            rejig_engagement_profile: profile,
            rejig_predicted_outcome: prediction.outcome,
            rejig_last_login: ctx.signals.rejig.lastLoginAt
              ? ctx.signals.rejig.lastLoginAt.toISOString()
              : null,
            rejig_days_since_last_post: ctx.signals.rejig.daysSinceLastPost,
            rejig_days_until_expiry: ctx.signals.rejig.daysUntilExpiry,
            rejig_posting_trajectory:
              trajectory.pattern === 'insufficient_data' ? null : trajectory.pattern,
          });
          summary.contactPropertiesWritten++;
        } catch (err) {
          console.warn(
            `[BI cron] HS Contact property push failed for ${c.id}`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // ─── Push Layer-4 action properties to HS Ticket ──────────────────
      // Properties-only per Pass 2.7 §29.7 Q-2.5-4 — Tier-B HubSpot Task
      // auto-creation is a flip-on-later feature (Phase 4-Polish).
      if (ctx.hubspotTicketId && action) {
        try {
          await updateTicketProperties(ctx.hubspotTicketId, {
            rejig_recommended_action: action.template.contentSummary,
            rejig_recommended_action_set_at: new Date().toISOString(),
            rejig_recommended_action_urgency: action.template.urgency,
          });
          summary.ticketActionPropertiesWritten++;
        } catch (err) {
          console.warn(
            `[BI cron] HS Ticket action property push failed for ${c.id}`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } catch (err) {
      summary.errors.push({
        customerId: c.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    summary.customersEvaluated++;
  }

  summary.durationMs = Date.now() - t0;
  console.log('[BI cron] complete', summary);

  return Response.json(summary);
}
