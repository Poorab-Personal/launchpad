/**
 * Run the BI cron logic locally (no Vercel timeout limit).
 * Mirrors the per-customer flow in src/app/api/cron/bi/route.ts so we can
 * do a one-shot post-backfill pass without hitting the function timeout.
 *
 * For ongoing weekly runs the Vercel cron handles it — this is a one-time
 * tool. Future weekly runs will be mostly no-ops on state and just refresh
 * HS properties.
 */
import { and, isNotNull, ne, or, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { applyStateTransition } from '@/lib/db';
import { buildBiContext } from '@/lib/bi/context';
import { classifyProfile } from '@/lib/bi/profile-classifier';
import { computeTrajectoriesForAllCustomers } from '@/lib/bi/trajectory-job';
import { RuleBasedOutcomePredictor } from '@/lib/bi/outcome-predictor';
import { recommendAction } from '@/lib/bi/action-recommender';
import { mapToState } from '@/lib/bi/state-mapper';
import {
  updateContactProperties,
  updateTicketProperties,
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
          trajectoryPattern: trajectory.pattern,
          actionTemplateId: action?.template.id ?? null,
        },
      });
      if (t.applied) transitions++;

      if (ctx.hubspotContactId) {
        try {
          await updateContactProperties(ctx.hubspotContactId, {
            rejig_engagement_profile: profile,
            rejig_predicted_outcome: prediction.outcome,
            rejig_last_login: ctx.signals.rejig.lastLoginAt?.toISOString() ?? null,
            rejig_days_since_last_post: ctx.signals.rejig.daysSinceLastPost,
            rejig_days_until_expiry: ctx.signals.rejig.daysUntilExpiry,
            rejig_posting_trajectory: trajectory.pattern === 'insufficient_data' ? null : trajectory.pattern,
          });
          contactsWritten++;
        } catch (err) {
          // non-blocking
        }
      }

      if (ctx.hubspotTicketId && action) {
        try {
          await updateTicketProperties(ctx.hubspotTicketId, {
            rejig_recommended_action: action.template.contentSummary,
            rejig_recommended_action_set_at: new Date().toISOString(),
            rejig_recommended_action_urgency: action.template.urgency,
          });
          ticketsWritten++;
        } catch (err) {
          // non-blocking
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
