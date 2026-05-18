/**
 * One-customer BI eval — used to spot-check the full property push without
 * waiting 12 minutes for the 671-customer batch.
 *
 *   npx tsx scripts/bi-single.ts <customerId>
 */
import { and, eq, desc } from 'drizzle-orm';
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
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npx tsx scripts/bi-single.ts <customerId|email>');
    process.exit(1);
  }
  const isUuid = /^[0-9a-f-]{36}$/.test(arg);
  const row = isUuid
    ? await db.query.customers.findFirst({ where: eq(customers.id, arg) })
    : await db.query.customers.findFirst({ where: eq(customers.contactEmail, arg) });
  if (!row) {
    console.error('Customer not found');
    process.exit(1);
  }
  console.log(`Customer: ${row.name} <${row.contactEmail}>  id=${row.id}`);
  console.log(`  hsContact=${row.hubspotContactId}  hsTicket=${row.hubspotTicketId}`);

  const ctx = await buildBiContext(row.id);
  if (!ctx) { console.error('No BiContext'); process.exit(1); }

  const profile = classifyProfile(ctx);
  const trajectory = ctx.signals.trajectory ?? makeInsufficientDataSnapshot();
  const prediction = RuleBasedOutcomePredictor.predict({ profile, trajectory, ctx });
  const action = recommendAction({ profile, trajectory, outcome: prediction.outcome, ctx });
  const stateDecision = mapToState({ profile, trajectory, outcome: prediction.outcome, ctx });

  console.log(`\nBI outputs:`);
  console.log(`  profile:    ${profile}`);
  console.log(`  outcome:    ${prediction.outcome} (${prediction.confidence})`);
  console.log(`  trajectory: ${trajectory.pattern} (${trajectory.confidence})`);
  console.log(`  state:      ${stateDecision.state}  reason=${stateDecision.attentionReason}`);
  console.log(`  action:     ${action?.template.id ?? 'none'} — ${action?.template.contentSummary ?? '(monitor)'}`);
  console.log(`  reasoning:  ${humanizeReasoning(prediction.reasoning) || '(none)'}`);
  console.log(`  billing:    ${ctx.billingRelationship}`);
  console.log(`  plan:       ${ctx.selectedPlanName}`);

  const t = await applyStateTransition({
    customerId: row.id,
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
  console.log(`\nState transition: ${t.applied ? 'APPLIED' : `no-op (${t.reason})`}`);

  const recent = await db.query.customerUsageSignals.findMany({
    where: and(
      eq(customerUsageSignals.customerId, row.id),
      eq(customerUsageSignals.signalType, SIGNAL_TYPES.REJIG_TOTAL_PUBLISHED_POSTS),
    ),
    orderBy: desc(customerUsageSignals.observedAt),
    limit: 2,
  });
  const signalsObservedAt = recent[0]?.observedAt ?? null;
  const curr = recent[0]?.signalValueNumeric != null ? Number(recent[0].signalValueNumeric) : null;
  const prev = recent[1]?.signalValueNumeric != null ? Number(recent[1].signalValueNumeric) : null;
  const postsLast7d = (curr != null && prev != null) ? Math.max(0, curr - prev) : null;

  if (ctx.hubspotContactId) {
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
    console.log('✓ Contact properties pushed');
  } else {
    console.log('(no HS contact)');
  }

  if (ctx.hubspotTicketId) {
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
    console.log('✓ Ticket properties pushed');
  } else {
    console.log('(no HS ticket)');
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
