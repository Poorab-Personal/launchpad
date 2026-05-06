import type { Customer, Call } from '@/types';

export type HealthFlag = 'green' | 'yellow' | 'red';

export type HealthResult = {
  flag: HealthFlag;
  reason: string;
};

/**
 * Stages that count as "past Getting Started" for the stale-no-call red flag.
 * Anything from Review Your Designs onward.
 */
const STAGES_PAST_GETTING_STARTED = new Set<string>([
  'Review Your Designs',
  'Prepare for Onboarding',
  'Onboarding Call',
  'Post Onboarding',
  'Review & Grow',
]);

const STALE_DAYS_THRESHOLD = 14;

function daysBetween(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / (1000 * 60 * 60 * 24));
}

/**
 * Health flag for a CSM book row.
 *
 * Red:
 *   - noShowCount > 1, OR
 *   - callBooked === false AND days-since-stage-entered > 14 AND stage past Getting Started
 * Yellow:
 *   - noShowCount === 1
 * Green:
 *   - otherwise
 */
export function customerHealth(customer: Customer, calls?: Call[]): HealthResult {
  // calls reserved for future health signals (e.g. last contact age).
  void calls;

  // Red: too many no-shows
  if (customer.noShowCount > 1) {
    return {
      flag: 'red',
      reason: `${customer.noShowCount} no-shows`,
    };
  }

  // Red: stale + no call booked + meaningfully into the flow
  const daysInStage = daysBetween(customer.stageEnteredAt);
  if (
    !customer.callBooked &&
    daysInStage !== null &&
    daysInStage > STALE_DAYS_THRESHOLD &&
    STAGES_PAST_GETTING_STARTED.has(customer.currentStage)
  ) {
    return {
      flag: 'red',
      reason: `${daysInStage}d in ${customer.currentStage}, no call booked`,
    };
  }

  // Yellow: one no-show
  if (customer.noShowCount === 1) {
    return {
      flag: 'yellow',
      reason: '1 no-show',
    };
  }

  return {
    flag: 'green',
    reason: 'On track',
  };
}

export function daysSinceStageEntered(customer: Customer, now: Date = new Date()): number | null {
  return daysBetween(customer.stageEnteredAt, now);
}
