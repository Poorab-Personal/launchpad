/**
 * Rejig — Customer Dashboard (unified card)
 *
 * Single card that renders the SAME unified view whether placed on a
 * HubSpot Contact record or a Ticket record. Uses useCrmContext to detect
 * the current object type, useCrmProperties to read same-object props,
 * and hubspot.fetch (HubSpot CRM API) to fetch the cross-object props +
 * association so CSMs see one consistent dashboard regardless of view.
 *
 * Data sources:
 *   - HS Contact properties (rejig_* — written weekly by /api/cron/bi)
 *   - HS Ticket properties (rejig_attention_*, rejig_recommended_action*,
 *     hs_pipeline_stage — written by the same cron)
 *   - HS Contact ↔ Ticket associations (so we can fetch the other side)
 *
 * Replaces the two earlier cards (EngagementCard for Contact + BiTicketCard
 * for Ticket) — same data, one place, one experience.
 */
import React from 'react';
import {
  hubspot,
  Text,
  Flex,
  Tile,
  Divider,
  LoadingSpinner,
  Link,
  Tag,
  EmptyState,
  Statistics,
  StatisticsItem,
} from '@hubspot/ui-extensions';
import { useCrmProperties, useAssociations } from '@hubspot/ui-extensions/crm';

const CONTACT_PROPS = [
  'rejig_engagement_profile',
  'rejig_predicted_outcome',
  'rejig_outcome_reasoning',
  'rejig_posting_trajectory',
  'rejig_trajectory_confidence',
  'rejig_last_login',
  'rejig_days_since_last_post',
  'rejig_days_until_expiry',
  'rejig_brokerage_channel',
  'rejig_billing_relationship',
  'rejig_plan_name',
  'onboarding_no_show_count',
  'launchpad_customer_id',
  'stripe_customer_id',
  'rejig_listing_count',
  'rejig_total_posts',
  'rejig_video_posts',
  'rejig_image_posts',
  'rejig_posts_last_7d',
  'rejig_signals_observed_at',
];

const TICKET_PROPS = [
  'hs_pipeline_stage',
  'rejig_attention_reason',
  'rejig_attention_set_at',
  'rejig_recommended_action',
  'rejig_recommended_action_urgency',
  'rejig_recommended_action_set_at',
  'subject',
];

const STAGE_LABEL = {
  '1360257164': 'Pre-Onboarding',
  '1154519674': 'Onboarding Scheduled',
  '1154519682': 'Active',
  '1360257165': 'Watch',
  '1154519683': 'At Risk',
  '1360257166': 'Critical',
  '1154519684': 'Churned',
  '1360257167': 'On Hold',
};

const STAGE_VARIANT = {
  '1154519682': 'success',     // Active
  '1360257165': 'warning',     // Watch
  '1154519683': 'warning',     // At Risk
  '1360257166': 'danger',      // Critical
  '1154519684': 'default',     // Churned
  '1154519674': 'default',     // Onboarding Scheduled
  '1360257164': 'default',     // Pre-Onboarding
  '1360257167': 'default',     // On Hold
};

const PROFILE_LABEL = {
  power_user: 'Power user',
  steady_user: 'Steady user',
  never_adopted: 'Never adopted',
  light_user_engaged: 'Light user, engaged',
  social_only: 'Social-only',
  trial_engaged: 'Trial, engaged',
  canceled_pending: 'Canceled, pending',
  light_user_dormant: 'Light user, dormant',
  paying_but_absent: 'Paying but absent',
  steady_user_declining: 'Steady user, declining',
  video_non_adopter: 'Video non-adopter',
  power_user_declining: 'Power user, declining',
  power_user_waning: 'Power user, waning',
  listings_only: 'Listings-only',
  trial_dormant: 'Trial, dormant',
  ineligible: 'Ineligible',
  steady_user_drifting: 'Steady user, drifting',
};

const PROFILE_VARIANT = {
  power_user: 'success', steady_user: 'success', light_user_engaged: 'success', trial_engaged: 'success',
  social_only: 'default', light_user_dormant: 'warning', paying_but_absent: 'warning',
  steady_user_declining: 'warning', steady_user_drifting: 'warning', power_user_declining: 'warning',
  power_user_waning: 'warning', video_non_adopter: 'warning', listings_only: 'warning',
  trial_dormant: 'danger', never_adopted: 'danger', canceled_pending: 'danger', ineligible: 'default',
};

const OUTCOME_LABEL = {
  likely_renew: 'Likely to renew',
  likely_renew_after_intervention: 'Likely to renew after intervention',
  likely_churn_in_60d: 'Likely to churn in 60d',
  likely_churn_in_30d: 'Likely to churn in 30d',
  near_certain_churn: 'Near-certain churn',
  unknown: 'Unknown',
};

const OUTCOME_VARIANT = {
  likely_renew: 'success', likely_renew_after_intervention: 'default',
  likely_churn_in_60d: 'warning', likely_churn_in_30d: 'warning',
  near_certain_churn: 'danger', unknown: 'default',
};

const TRAJECTORY_LABEL = {
  ramping: 'Ramping', steady: 'Steady', declining: 'Declining', recovering: 'Recovering',
  oscillating_2: 'Oscillating (2-week)', oscillating_3: 'Oscillating (3-week)',
  terminally_declining: 'Terminally declining', oscillating_4plus: 'Oscillating (4+ week)',
  insufficient_data: 'Insufficient data',
};

const BILLING_LABEL = {
  paying: 'Paying', comped: 'Comped', internal_demo: 'Internal demo',
};

const BILLING_VARIANT = {
  paying: 'success', comped: 'default', internal_demo: 'default',
};

const CONFIDENCE_LABEL = {
  high: 'high confidence', medium: 'medium confidence', low: 'low confidence',
};

const ATTENTION_REASON_LABEL = {
  no_show_no_rebook: 'No-show, no rebook',
  no_show_pattern: 'No-show pattern',
  customer_cancelled_onboarding: 'Customer cancelled onboarding',
  partial_no_completion: 'Onboarding partially complete',
  payment_failed: 'Payment failed',
  payment_past_due: 'Payment past due',
  stuck_in_onboarding: 'Stuck in onboarding',
  engagement_drop_30d: 'Engagement drop (30d)',
  renewal_approaching_6w: 'Renewal approaching (6w)',
  renewal_approaching_2w: 'Renewal approaching (2w)',
};

const URGENCY_LABEL = { today: 'TODAY', this_week: 'THIS WEEK', monitor: 'MONITOR' };
const URGENCY_VARIANT = { today: 'danger', this_week: 'warning', monitor: 'default' };

const LP_ADMIN_BASE = 'https://onboarding.rejig.ai/admin/';
const STRIPE_CUSTOMER_BASE = 'https://dashboard.stripe.com/customers/';

hubspot.extend(({ context }) => <RejigCustomerCard context={context} />);

function RejigCustomerCard({ context }) {
  // context.crm.objectTypeId: '0-1' = Contact, '0-5' = Ticket
  const objectTypeId = context?.crm?.objectTypeId;
  const objectId = context?.crm?.objectId;
  const isContactView = objectTypeId === '0-1';
  const isTicketView = objectTypeId === '0-5';

  // Read the CURRENT object's props (whichever side we're on)
  const propsToRead = isContactView ? CONTACT_PROPS : TICKET_PROPS;
  const { properties: currentProps, isLoading: currentLoading } = useCrmProperties(propsToRead);

  // Fetch the OTHER object's props via the association hook. The hook
  // resolves the association + reads properties in one shot; works in
  // both directions because it always operates relative to the current
  // record (set by hubspot.extend's context).
  const otherType = isContactView ? 'tickets' : 'contacts';
  const otherPropsToFetch = isContactView ? TICKET_PROPS : CONTACT_PROPS;
  const { results: assocResults, isLoading: assocLoading } = useAssociations({
    toObjectType: otherType,
    properties: otherPropsToFetch,
    pageLength: 5,
  });
  const otherProps = assocResults?.[0]?.properties ?? {};

  if (currentLoading || assocLoading) {
    return <LoadingSpinner label="Loading Rejig dashboard…" />;
  }

  // Merge: ALWAYS map Contact-side fields → contactBag; Ticket-side → ticketBag.
  // Whichever side is current comes from currentProps; other side from otherProps.
  const contactBag = isContactView ? currentProps : (otherProps || {});
  const ticketBag = isTicketView ? currentProps : (otherProps || {});

  // CONTACT-SIDE (engagement)
  const profile = contactBag.rejig_engagement_profile;
  const outcome = contactBag.rejig_predicted_outcome;
  const outcomeReasoning = contactBag.rejig_outcome_reasoning;
  const trajectory = contactBag.rejig_posting_trajectory;
  const trajectoryConfidence = contactBag.rejig_trajectory_confidence;
  const channel = contactBag.rejig_brokerage_channel;
  const billing = contactBag.rejig_billing_relationship;
  const planName = contactBag.rejig_plan_name;
  const noShow = numberOrNull(contactBag.onboarding_no_show_count);
  const daysSincePost = numberOrNull(contactBag.rejig_days_since_last_post);
  const daysUntilExpiry = numberOrNull(contactBag.rejig_days_until_expiry);
  const lastLogin = contactBag.rejig_last_login;
  const customerId = contactBag.launchpad_customer_id;
  const stripeCustomerId = contactBag.stripe_customer_id;
  const listingCount = numberOrNull(contactBag.rejig_listing_count);
  const totalPosts = numberOrNull(contactBag.rejig_total_posts);
  const videoPosts = numberOrNull(contactBag.rejig_video_posts);
  const imagePosts = numberOrNull(contactBag.rejig_image_posts);
  const postsLast7d = numberOrNull(contactBag.rejig_posts_last_7d);
  const signalsObservedAt = contactBag.rejig_signals_observed_at;

  // TICKET-SIDE (attention + action + stage)
  const stage = ticketBag.hs_pipeline_stage;
  const reason = ticketBag.rejig_attention_reason;
  const reasonSetAt = ticketBag.rejig_attention_set_at;
  const action = ticketBag.rejig_recommended_action;
  const urgency = ticketBag.rejig_recommended_action_urgency;
  const actionSetAt = ticketBag.rejig_recommended_action_set_at;

  const lastLoginDate = parseHsDateTime(lastLogin);
  const daysSinceLogin = lastLoginDate
    ? Math.floor((Date.now() - lastLoginDate.getTime()) / 86400000)
    : null;

  const hasAnyContent = profile || outcome || trajectory || stage || reason || action;
  if (!hasAnyContent) {
    return (
      <EmptyState title="No Rejig data yet" layout="vertical">
        <Text variant="microcopy">
          BI cron has not evaluated this customer yet. Signals refresh every Sunday 06:00 UTC.
        </Text>
      </EmptyState>
    );
  }

  return (
    <Tile>
      <Flex direction="column" gap="medium">
        {/* ─── HEADER: state, channel, billing ─── */}
        <Flex direction="row" gap="extra-small" wrap="wrap">
          {stage ? (
            <Tag variant={STAGE_VARIANT[stage] || 'default'}>
              {STAGE_LABEL[stage] || stage}
            </Tag>
          ) : null}
          {channel ? <Tag variant="default">{channel}</Tag> : null}
          {billing ? (
            <Tag variant={BILLING_VARIANT[billing] || 'default'}>
              {BILLING_LABEL[billing] || billing}
            </Tag>
          ) : null}
        </Flex>

        {/* ─── PREDICTION + TRAJECTORY ─── */}
        <Flex direction="column" gap="extra-small">
          <LabeledRow label="Profile">
            {profile ? (
              <Tag variant={PROFILE_VARIANT[profile] || 'default'}>
                {PROFILE_LABEL[profile] || profile}
              </Tag>
            ) : (
              <Text variant="microcopy">—</Text>
            )}
          </LabeledRow>
          <LabeledRow label="Predicted">
            {outcome ? (
              <Tag variant={OUTCOME_VARIANT[outcome] || 'default'}>
                {OUTCOME_LABEL[outcome] || outcome}
              </Tag>
            ) : (
              <Text variant="microcopy">—</Text>
            )}
          </LabeledRow>
          {outcomeReasoning ? (
            <Text variant="microcopy" format={{ italic: true }}>
              {outcomeReasoning}
            </Text>
          ) : null}
          <LabeledRow label="Trajectory">
            <Text>
              {trajectory ? (TRAJECTORY_LABEL[trajectory] || trajectory) : '—'}
              {trajectory && trajectoryConfidence
                ? ` · ${CONFIDENCE_LABEL[trajectoryConfidence] || trajectoryConfidence}`
                : ''}
            </Text>
          </LabeledRow>
        </Flex>

        {/* ─── ATTENTION + ACTION (skip when fully clean) ─── */}
        {(reason || action) ? (
          <>
            <Divider />
            <Flex direction="column" gap="extra-small">
              <LabeledRow label="Attention">
                {reason ? (
                  <Tag variant="warning">{ATTENTION_REASON_LABEL[reason] || reason}</Tag>
                ) : (
                  <Text variant="microcopy">—</Text>
                )}
              </LabeledRow>
              {reasonSetAt ? (
                <LabeledRow label="Since">
                  <Text>{formatRelativeAndAbsolute(reasonSetAt)}</Text>
                </LabeledRow>
              ) : null}
              {action ? (
                <>
                  <Flex direction="row" gap="small" align="center">
                    <Text format={{ fontWeight: 'bold' }} variant="microcopy">
                      URGENCY
                    </Text>
                    {urgency ? (
                      <Tag variant={URGENCY_VARIANT[urgency] || 'default'}>
                        {URGENCY_LABEL[urgency] || urgency}
                      </Tag>
                    ) : (
                      <Text variant="microcopy">—</Text>
                    )}
                  </Flex>
                  <Text>{action}</Text>
                  {actionSetAt ? (
                    <Text variant="microcopy">Set {formatRelativeAndAbsolute(actionSetAt)}</Text>
                  ) : null}
                </>
              ) : null}
            </Flex>
          </>
        ) : null}

        <Divider />

        {/* ─── POSTING STATS ─── */}
        <Statistics>
          <StatisticsItem
            label="Posts last 7d"
            number={postsLast7d != null ? postsLast7d : 'Too early'}
          />
          <StatisticsItem label="Total posts" number={totalPosts ?? 0} />
          <StatisticsItem label="Listings" number={listingCount ?? 0} />
        </Statistics>
        <Statistics>
          <StatisticsItem label="Video posts" number={videoPosts ?? 0} />
          <StatisticsItem label="Image posts" number={imagePosts ?? 0} />
        </Statistics>

        <Divider />

        {/* ─── ACCOUNT / RENEWAL ─── */}
        <Flex direction="column" gap="extra-small">
          <LabeledRow label="Last login">
            <Text>{lastLoginDate ? formatRelativeAndAbsolute(lastLogin) : '—'}</Text>
          </LabeledRow>
          {daysSinceLogin != null ? (
            <LabeledRow label="Days since login">
              <Text>{daysSinceLogin}</Text>
            </LabeledRow>
          ) : null}
          <LabeledRow label="Days since last post">
            <Text>{daysSincePost ?? '—'}</Text>
          </LabeledRow>
          <LabeledRow label={planName ? `Plan · ${planName}` : 'Plan'}>
            <Text>{formatExpiry(daysUntilExpiry)}</Text>
          </LabeledRow>
          {noShow != null && noShow > 0 ? (
            <LabeledRow label="No-shows so far">
              <Tag variant="warning">{noShow}</Tag>
            </LabeledRow>
          ) : null}
        </Flex>

        {/* ─── CROSS-SYSTEM LINKS ─── */}
        {(customerId || stripeCustomerId) ? (
          <>
            <Divider />
            <Flex direction="column" gap="extra-small">
              {customerId ? (
                <Link href={`${LP_ADMIN_BASE}${customerId}`} external>
                  Open in LaunchPad admin
                </Link>
              ) : null}
              {stripeCustomerId ? (
                <Link href={`${STRIPE_CUSTOMER_BASE}${stripeCustomerId}`} external>
                  Open in Stripe
                </Link>
              ) : null}
            </Flex>
          </>
        ) : null}

        <Text variant="microcopy">
          {daysUntilExpiry != null && daysUntilExpiry < 0
            ? 'Rejig data not updating — plan expired (see Stripe for current status)'
            : `Rejig data as of ${formatFreshness(signalsObservedAt)}`}
        </Text>
      </Flex>
    </Tile>
  );
}

function LabeledRow({ label, children }) {
  return (
    <Flex direction="row" justify="between" align="center" gap="small">
      <Text format={{ fontWeight: 'bold' }} variant="microcopy">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

function numberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseHsDateTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatRelativeAndAbsolute(raw) {
  const d = parseHsDateTime(raw);
  if (!d) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const abs = d.toISOString().slice(0, 10);
  if (days === 0) return `today (${abs})`;
  if (days === 1) return `1 day ago (${abs})`;
  if (days < 0) return `in ${-days} days (${abs})`;
  return `${days} days ago (${abs})`;
}

function formatExpiry(days) {
  if (days == null) return '—';
  if (days < 0) return `Expired ${-days} days ago`;
  if (days === 0) return 'Expires today';
  return `${days} days`;
}

function formatFreshness(raw) {
  const d = parseHsDateTime(raw);
  if (!d) return 'unknown';
  const abs = d.toISOString().slice(0, 10);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return `today (${abs})`;
  if (days === 1) return `1 day ago (${abs})`;
  return `${days} days ago (${abs})`;
}
