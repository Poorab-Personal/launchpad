/**
 * Humanizes `OutcomePrediction.reasoning[]` for CSM-facing surfaces.
 *
 * The predictor emits code-style predicates (`profile='never_adopted'`,
 * `tenureDays=92 >= 30`) that are great for audit logs but unreadable on
 * a HubSpot card. This module converts the top-2 predicates into a short
 * "X · Y" sentence — concise enough to fit beneath the outcome tag.
 *
 * Kept conservative: anything we don't recognize falls through with a
 * light cleanup (strip quotes, normalize dots), so a new predicate added
 * upstream still renders something sensible instead of breaking the card.
 */

const PATTERNS: Array<{ re: RegExp; out: (m: RegExpMatchArray) => string }> = [
  // profile='X' (healthy/recoverable)
  {
    re: /^profile='([^']+)'(?:\s+\((healthy|recoverable)\))?$/,
    out: (m) => `profile: ${m[1].replace(/_/g, ' ')}${m[2] ? ` (${m[2]})` : ''}`,
  },
  // trajectory.pattern='X' (with optional (healthy|recoverable))
  {
    re: /^trajectory\.pattern='([^']+)'(?:\s+\((healthy|recoverable)\))?$/,
    out: (m) => `trajectory: ${m[1].replace(/_/g, ' ')}${m[2] ? ` (${m[2]})` : ''}`,
  },
  // subscriptionStatus='X'
  {
    re: /^subscriptionStatus='([^']+)'$/,
    out: (m) => `subscription ${m[1].toLowerCase()}`,
  },
  // stripe.lastSubscriptionStatus='past_due'
  {
    re: /^stripe\.lastSubscriptionStatus='([^']+)'$/,
    out: (m) => `Stripe status: ${m[1].replace(/_/g, ' ')}`,
  },
  // tenureDays=N >= M
  {
    re: /^tenureDays=(\d+)\s*>=\s*(\d+)$/,
    out: (m) => `tenure ${m[1]}d (≥ ${m[2]}d)`,
  },
  // tenureDays=N < M   (brand-new unknown bucket)
  {
    re: /^tenureDays=(\d+)\s*<\s*(\d+)$/,
    out: (m) => `tenure ${m[1]}d (< ${m[2]}d, brand new)`,
  },
  // tenureDays=N in [a, b]
  {
    re: /^tenureDays=(\d+)\s+in\s+\[(\d+),\s*(\d+)\]$/,
    out: (m) => `tenure ${m[1]}d (in ${m[2]}–${m[3]}d window)`,
  },
  // daysUntilExpiry=N <= M
  {
    re: /^daysUntilExpiry=(-?\d+)\s*<=\s*(\d+)$/,
    out: (m) => `expires in ${m[1]}d`,
  },
  // rejig.totalPosts=N
  {
    re: /^rejig\.totalPosts=(\d+)$/,
    out: (m) => `${m[1]} total posts`,
  },
  // rejig.lastLoginAt=null
  {
    re: /^rejig\.lastLoginAt=null$/,
    out: () => 'never logged in',
  },
  // stripe.lastPaymentFailedAt within last 14d (5d ago)
  {
    re: /^stripe\.lastPaymentFailedAt within last (\d+)d \((\d+)d ago\)$/,
    out: (m) => `payment failed ${m[2]}d ago`,
  },
  // no subsequent lastPaymentSucceededAt
  {
    re: /^no subsequent lastPaymentSucceededAt$/,
    out: () => 'no recovery yet',
  },
  // no payment_failed in last 14d
  {
    re: /^no payment_failed in last \d+d$/,
    out: () => 'no recent payment failure',
  },
  // no rule matched
  {
    re: /^no rule matched$/,
    out: () => 'no specific signal',
  },
];

function humanizeOne(predicate: string): string {
  const s = predicate.trim();
  for (const { re, out } of PATTERNS) {
    const m = s.match(re);
    if (m) return out(m);
  }
  // Fallback: drop the most code-y characters so it still reads.
  return s.replace(/'/g, '').replace(/_/g, ' ').replace(/^\w+\./, '');
}

/**
 * Picks the two most-informative predicates and joins them with " · ".
 * Returns '' for empty input so callers can null-check.
 */
export function humanizeReasoning(reasoning: readonly string[] | null | undefined): string {
  if (!reasoning || reasoning.length === 0) return '';
  const parts = reasoning.slice(0, 2).map(humanizeOne).filter(Boolean);
  return parts.join(' · ');
}
