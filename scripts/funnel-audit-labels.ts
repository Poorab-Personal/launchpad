/**
 * Display config for funnel-audit milestones.
 *
 * Lives here (not in the DB) by design: see SKILL.md "Labels — why not
 * the DB". Adding columns to workflow_templates for display concerns
 * isn't worth a migration on a live system.
 *
 * If the audit script encounters a milestone with no entry, it falls
 * back to the raw task title AND prints a warning banner pointing back
 * to this file.
 */

// Label = "[what they did], [what's missing]" — describes WHERE THEY'RE
// STUCK, not what they completed. Each bucket is a distinct gap in the
// funnel; the label tells ops what to nudge.
//
// "Booked" and "Onboarded" are terminal-ish so they stand alone (no
// gap to describe).
export const BASE_LABELS: Record<string, string> = {
  'Confirm Your Information': 'Submitted, no card',
  'Capture Payment Method': 'Card saved, didn\'t book',
  'Schedule Your Onboarding Call': 'Booked',
};

// Bucket-0 label (no milestones completed yet). Separate from the
// milestone map because it doesn't correspond to a task.
export const STARTED_LABEL = 'Started, didn\'t submit';

// Per-workflow overrides for the rare divergence. Empty today.
export const PER_WORKFLOW: Record<string, Record<string, string>> = {};

export function getStateLabel(workflowKey: string, taskTitle: string): string | undefined {
  return PER_WORKFLOW[workflowKey]?.[taskTitle] ?? BASE_LABELS[taskTitle];
}

/**
 * How to detect "actually onboarded" (vs just past-Schedule).
 *
 * - 'subscription' — Stripe trial sub exists (subscriptionStatus IS NOT
 *   NULL). For IPRE/Keyes, the trial sub is created when the HubSpot
 *   Ticket flips to Active post-meeting, so this is the real
 *   post-meeting signal.
 * - 'stage' — currentStage advanced past 'Getting Started'. Looser, but
 *   the only signal for workflows without Stripe trials (e.g. BW).
 *
 * Default when a workflow isn't listed: 'subscription' (conservative
 * for the B2B trial cohort). Add an entry to opt out.
 */
export const ONBOARDED_RULE: Record<string, 'subscription' | 'stage'> = {
  'B2B-IPRE': 'subscription',
  'B2B-Keyes': 'subscription',
  'B2B-BW': 'stage',
};

export function getOnboardedRule(workflowKey: string): 'subscription' | 'stage' {
  return ONBOARDED_RULE[workflowKey] ?? 'subscription';
}

/**
 * After this many days in a non-terminal stuck bucket (Started /
 * Submitted, no card / Card saved, didn't book), flag the row red.
 *
 * 3 days is the working default for B2B onboarding — past that, the
 * customer is materially at risk of dropping off without a nudge.
 *
 * Overridable per-run via --stuck-days N.
 *
 * NOT applied to: Booked (they have a scheduled date), Onboarded
 * (terminal).
 */
export const STUCK_DAYS_THRESHOLD = 3;
