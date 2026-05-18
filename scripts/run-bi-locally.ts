/**
 * Run the BI cron logic locally (no Vercel timeout limit).
 * Mirrors the per-customer flow in src/app/api/cron/bi/route.ts so we can
 * do a one-shot post-backfill pass without hitting the function timeout.
 *
 * For ongoing weekly runs the Vercel cron handles it — this is a one-time
 * tool. Future weekly runs will be mostly no-ops on state and just refresh
 * HS properties.
 */
import { and, isNotNull, ne, or, isNull, eq, desc } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import { applyStateTransition } from '@/lib/db';
import { buildBiContext } from '@/lib/bi/context';
import { classifyProfile } from '@/lib/bi/profile-classifier';
import { computeTrajectoriesForAllCustomers } from '@/lib/bi/trajectory-job';
import { RuleBasedOutcomePredictor } from '@/lib/bi/outcome-predictor';
import { recommendAction } from '@/lib/bi/action-recommender';
import { mapToState } from '@/lib/bi/state-mapper';
import { humanizeReasoning } from '@/lib/bi/humanize-reasoning';
import { SIGNAL_TYPES } from '@/lib/bi/signal-types';
import {
  updateContactProperties,
  updateTicketProperties,
  pushTicketStage,
} from '@/lib/integrations/hubspot/client';
import type { TrajectorySnapshot } from '@/lib/bi/types';

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

async function main() {
  const t0 = Date.now();
  const ruleFires: Record<string, number> = {};
  function bump(k: string) { ruleFires[k] = (ruleFires[k] ?? 0) + 1; }

  console.log('[bi-local] Phase 1 — trajectory job…');
  try {
    const traj = await computeTrajectoriesForAllCustomers();
    console.log(`[bi-local]   processed=${traj.customersProcessed} written=${traj.trajectoriesWritten}`);
  } catch (err) {
    console.error('[bi-local] trajectory job failed:', err instanceof Error ? err.message : err);
  }

  const list = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        isNotNull(customers.onboardingState),
        isNotNull(customers.subscriptionStatus),
        or(
          ne(customers.billingRelationship, 'internal_demo'),
          isNull(customers.billingRelationship),
        ),
      ),
    );

  console.log(`[bi-local] Phase 2 — evaluating ${list.length} customers…`);
  let transitions = 0, contactsWritten = 0, ticketsWritten = 0, errors = 0;

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    try {
      const ctx = await buildBiContext(c.id);
      if (!ctx) continue;
      const profile = classifyProfile(ctx);
      bump(`profile:${profile}`);
      const trajectory = ctx.signals.trajectory ?? makeInsufficientDataSnapshot();
      bump(`trajectory:${trajectory.pattern}`);
      const prediction = RuleBasedOutcomePredictor.predict({ profile, trajectory, ctx });
      bump(`outcome:${prediction.outcome}`);
      const action = recommendAction({ profile, trajectory, outcome: prediction.outcome, ctx });
      bump(action ? `action:${action.template.id}` : 'action:none');
      const stateDecision = mapToState({ profile, trajectory, outcome: prediction.outcome, ctx });
      bump(`state:${stateDecision.state}`);

      const t = await applyStateTransition({
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
      if (t.applied) transitions++;

      const recentTotalSigs = await db.query.customerUsageSignals.findMany({
        where: and(
          eq(customerUsageSignals.customerId, c.id),
          eq(customerUsageSignals.signalType, SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS),
        ),
        orderBy: desc(customerUsageSignals.observedAt),
        limit: 2,
      });
      const signalsObservedAt = recentTotalSigs[0]?.observedAt ?? null;
      const currTotal = recentTotalSigs[0]?.signalValueNumeric != null
        ? Number(recentTotalSigs[0].signalValueNumeric)
        : null;
      const prevTotal = recentTotalSigs[1]?.signalValueNumeric != null
        ? Number(recentTotalSigs[1].signalValueNumeric)
        : null;
      const postsLast7d = (currTotal != null && prevTotal != null)
        ? Math.max(0, currTotal - prevTotal)
        : null;

      if (ctx.hubspotContactId) {
        try {
          await updateContactProperties(ctx.hubspotContactId, {
            rejig_engagement_profile: profile,
            rejig_predicted_outcome: prediction.outcome,
            rejig_outcome_reasoning: humanizeReasoning(prediction.reasoning) || null,
            rejig_trajectory_confidence: trajectory.pattern === 'insufficient_data' ? null : trajectory.confidence,
            rejig_billing_relationship: ctx.billingRelationship ?? null,
            rejig_plan_name: ctx.selectedPlanName ?? null,
            rejig_last_login: ctx.signals.rejig.lastLoginAt?.toISOString() ?? null,
            rejig_days_since_last_post: ctx.signals.rejig.daysSinceLastPost,
            rejig_days_until_expiry: ctx.signals.rejig.daysUntilExpiry,
            rejig_posting_trajectory: trajectory.pattern === 'insufficient_data' ? null : trajectory.pattern,
            rejig_listing_count: ctx.signals.rejig.listingCount,
            rejig_total_posts: ctx.signals.rejig.totalPosts,
            rejig_video_posts: ctx.signals.rejig.videoPosts,
            rejig_image_posts: ctx.signals.rejig.imagePosts,
            rejig_posts_last_7d: postsLast7d,
            rejig_signals_observed_at: signalsObservedAt?.toISOString() ?? null,
          });
          contactsWritten++;
        } catch (err) {
          if ((i + 1) % 100 === 0) {
            console.warn(`\n[bi-local] contact push failed for ${c.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      // F4: ALWAYS push attention_reason + action to Ticket on every eval,
      // regardless of whether state actually transitioned. Decoupling from
      // applyStateTransition (which only fires on real transitions) ensures
      // backfilled tickets that never transitioned still get the current
      // attention/action surfaced on the HS Engagement Card.
      if (ctx.hubspotTicketId) {
        try {
          const ticketProps: Record<string, string | number | boolean | null> = {
            rejig_attention_reason: stateDecision.attentionReason ?? null,
            rejig_attention_set_at:
              stateDecision.attentionReason && ctx.attentionSetAt
                ? ctx.attentionSetAt.toISOString()
                : stateDecision.attentionReason
                ? new Date().toISOString()
                : null,
          };
          if (action) {
            ticketProps.rejig_recommended_action = action.template.contentSummary;
            ticketProps.rejig_recommended_action_urgency = action.template.urgency;
            ticketProps.rejig_recommended_action_set_at = new Date().toISOString();
          } else {
            ticketProps.rejig_recommended_action = 'Healthy customer — monitor only';
            ticketProps.rejig_recommended_action_urgency = 'monitor';
            ticketProps.rejig_recommended_action_set_at = new Date().toISOString();
          }
          await updateTicketProperties(ctx.hubspotTicketId, ticketProps);
          ticketsWritten++;
        } catch (err) {
          if ((i + 1) % 100 === 0) {
            console.warn(`\n[bi-local] ticket push failed for ${c.id}: ${err instanceof Error ? err.message : err}`);
          }
        }

        // F4-ext: unconditional stage push. applyStateTransition only pushes
        // stage on transition, leaving backfilled tickets with stale stages
        // (e.g. backfill set "Active" but BI later decided "Watch" with no
        // transition fired → HS shows Active forever). Push every eval so
        // HS stage always matches LP state.
        try {
          await pushTicketStage(ctx.hubspotTicketId, stateDecision.state);
        } catch (err) {
          if ((i + 1) % 100 === 0) {
            console.warn(`\n[bi-local] stage push failed for ${c.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    } catch (err) {
      errors++;
    }
    if ((i + 1) % 25 === 0 || i + 1 === list.length) {
      process.stdout.write(`\r[bi-local] ${i + 1}/${list.length} | transitions=${transitions} contacts=${contactsWritten} tickets=${ticketsWritten} errors=${errors}`);
    }
  }
  process.stdout.write('\n');

  console.log('\n=== SUMMARY ===');
  console.log(`Duration: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`Customers evaluated: ${list.length}`);
  console.log(`State transitions applied: ${transitions}`);
  console.log(`Contact properties written: ${contactsWritten}`);
  console.log(`Ticket action properties written: ${ticketsWritten}`);
  console.log(`Errors: ${errors}`);
  console.log('\n— Rule fires —');
  for (const [k, v] of Object.entries(ruleFires).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
