import type { ActionTemplate, ActionUrgency } from './types';

/**
 * V1 action library — 15 templates A1-A15 mapping (predicted_outcome,
 * profile, trajectory) combinations to concrete CSM interventions.
 * Pass 2.5 §14.1. A16-A18 (Intercom/HS Conversations interventions)
 * DEFERRED per Pass 2.7 §29.3.
 *
 * Ordered by urgency descending (today → this_week → monitor). The
 * recommender uses first-match-wins; ordering is the priority
 * mechanism.
 */
export const ACTION_LIBRARY: ActionTemplate[] = [
  // ===== URGENCY: today =====
  // A13: 4th peter-out — CSM call this week
  {
    id: 'A13',
    actionType: ['csm_call'],
    contentSummary: '4th peter-out detected; CSM call THIS WEEK with pause-vs-cancel offer',
    urgency: 'today',
  },
  // A12: terminally declining — last-chance call
  {
    id: 'A12',
    actionType: ['csm_call'],
    contentSummary: 'Last-chance CSM call; offer pause/downgrade as retention',
    urgency: 'today',
  },
  // A11: payment failed — billing follow-up
  {
    id: 'A11',
    actionType: ['task_create', 'email_template'],
    contentSummary: 'Billing dispute follow-up; send updated payment link',
    urgency: 'today',
  },
  // A14: near_certain_churn + canceled_pending — reactivation offer
  {
    id: 'A14',
    actionType: ['email_template'],
    contentSummary: 'Last-week reactivation offer (20% off renewal)',
    urgency: 'today',
  },
  // A10: paying_but_absent at risk of churn — outbound call
  {
    id: 'A10',
    actionType: ['csm_call'],
    contentSummary: 'CSM outbound call; verify access; offer onboarding redo',
    urgency: 'today',
  },
  // A9: oscillating_3 — root-cause discovery call
  {
    id: 'A9',
    actionType: ['csm_call'],
    contentSummary: 'CSM personal call THIS WEEK; root-cause discovery (forgot/hard/value)',
    urgency: 'today',
  },

  // ===== URGENCY: this_week =====
  // A8: oscillating_2 — personal email
  {
    id: 'A8',
    actionType: ['task_create', 'email_template'],
    contentSummary: 'Personal CSM email; ask "what has been hard about staying consistent?"',
    urgency: 'this_week',
  },
  // A4: never_adopted + intervention — Loom + call
  {
    id: 'A4',
    actionType: ['loom_send', 'task_create'],
    contentSummary: 'Send 90-second walkthrough Loom; schedule onboarding refresher call',
    urgency: 'this_week',
  },
  // A2: power_user_declining — re-engagement email
  {
    id: 'A2',
    actionType: ['email_template', 'task_create'],
    contentSummary: 'Re-engagement email referencing top 3 past posts; schedule CSM check-in for next week',
    urgency: 'this_week',
  },
  // A3: power_user_waning — "we miss you"
  {
    id: 'A3',
    actionType: ['email_template'],
    contentSummary: 'Send "we miss you" nudge with a recent industry article',
    urgency: 'this_week',
  },
  // A7: steady_user_declining — content idea nudge
  {
    id: 'A7',
    actionType: ['email_template'],
    contentSummary: 'Send "3 quick post ideas this week" nudge',
    urgency: 'this_week',
  },

  // ===== URGENCY: monitor =====
  // A5: video_non_adopter — video tutorial Loom
  {
    id: 'A5',
    actionType: ['loom_send'],
    contentSummary: 'Send 60-second "create your first AI video" Loom',
    urgency: 'monitor',
  },
  // A6: listings_only — auto-post tutorial
  {
    id: 'A6',
    actionType: ['loom_send'],
    contentSummary: 'Send "auto-post your listings" tutorial Loom',
    urgency: 'monitor',
  },
  // A1: likely_renew — no action; surface for upsell consideration
  {
    id: 'A1',
    actionType: ['no_action'],
    contentSummary: 'Healthy customer — no action; eligible for upsell campaigns',
    urgency: 'monitor',
  },
  // A15: unknown — no action
  {
    id: 'A15',
    actionType: ['no_action'],
    contentSummary: 'Insufficient data — no action; monitor',
    urgency: 'monitor',
  },
];

// Compile-time invariant: library is ordered urgency-monotonic
//   today → this_week → monitor
// Violating this breaks first-match-wins priority.
const URGENCY_ORDER: Record<ActionUrgency, number> = { today: 0, this_week: 1, monitor: 2 };
ACTION_LIBRARY.forEach((tmpl, i) => {
  if (i > 0 && URGENCY_ORDER[tmpl.urgency] < URGENCY_ORDER[ACTION_LIBRARY[i - 1].urgency]) {
    throw new Error(`ACTION_LIBRARY out of order at index ${i}: ${tmpl.id}`);
  }
});
