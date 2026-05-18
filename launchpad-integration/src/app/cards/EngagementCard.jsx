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
import { useCrmProperties } from '@hubspot/ui-extensions/crm';

// Properties written weekly by /api/cron/bi (see scripts/setup-hubspot-properties.ts).
const PROPS = [
  'rejig_engagement_profile',
  'rejig_predicted_outcome',
  'rejig_outcome_reasoning',
  'rejig_posting_trajectory',
  'rejig_last_login',
  'rejig_days_since_last_post',
  'rejig_days_until_expiry',
  'rejig_brokerage_channel',
  'onboarding_no_show_count',
  'launchpad_customer_id',
  'rejig_listing_count',
  'rejig_total_posts',
  'rejig_video_posts',
  'rejig_image_posts',
  'rejig_posts_last_7d',
  'rejig_signals_observed_at',
];

// Mirrors src/lib/bi/types.ts EngagementProfile (17 values).
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
  power_user: 'success',
  steady_user: 'success',
  light_user_engaged: 'success',
  trial_engaged: 'success',
  social_only: 'default',
  light_user_dormant: 'warning',
  paying_but_absent: 'warning',
  steady_user_declining: 'warning',
  steady_user_drifting: 'warning',
  power_user_declining: 'warning',
  power_user_waning: 'warning',
  video_non_adopter: 'warning',
  listings_only: 'warning',
  trial_dormant: 'danger',
  never_adopted: 'danger',
  canceled_pending: 'danger',
  ineligible: 'default',
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
  likely_renew: 'success',
  likely_renew_after_intervention: 'default',
  likely_churn_in_60d: 'warning',
  likely_churn_in_30d: 'warning',
  near_certain_churn: 'danger',
  unknown: 'default',
};

const TRAJECTORY_LABEL = {
  ramping: 'Ramping',
  steady: 'Steady',
  declining: 'Declining',
  recovering: 'Recovering',
  oscillating_2: 'Oscillating (2-week)',
  oscillating_3: 'Oscillating (3-week)',
  terminally_declining: 'Terminally declining',
  oscillating_4plus: 'Oscillating (4+ week)',
  insufficient_data: 'Insufficient data',
};

const LP_ADMIN_BASE = 'https://launchpad-indol-ten.vercel.app/admin/';

hubspot.extend(() => <EngagementCard />);

function EngagementCard() {
  const { properties, isLoading, error } = useCrmProperties(PROPS);

  if (isLoading) return <LoadingSpinner label="Loading Rejig signals…" />;
  if (error) return <Text variant="microcopy">Couldn't load Rejig signals.</Text>;

  const p = properties || {};
  const profile = p.rejig_engagement_profile;
  const outcome = p.rejig_predicted_outcome;
  const outcomeReasoning = p.rejig_outcome_reasoning;
  const trajectory = p.rejig_posting_trajectory;
  const channel = p.rejig_brokerage_channel;
  const noShow = numberOrNull(p.onboarding_no_show_count);
  const daysSincePost = numberOrNull(p.rejig_days_since_last_post);
  const daysUntilExpiry = numberOrNull(p.rejig_days_until_expiry);
  const lastLogin = p.rejig_last_login;
  const customerId = p.launchpad_customer_id;
  const listingCount = numberOrNull(p.rejig_listing_count);
  const totalPosts = numberOrNull(p.rejig_total_posts);
  const videoPosts = numberOrNull(p.rejig_video_posts);
  const imagePosts = numberOrNull(p.rejig_image_posts);
  const postsLast7d = numberOrNull(p.rejig_posts_last_7d);
  const signalsObservedAt = p.rejig_signals_observed_at;

  const hasAnyBI = profile || outcome || trajectory;

  if (!hasAnyBI) {
    return (
      <EmptyState title="No Rejig signals yet" layout="vertical">
        <Text variant="microcopy">
          BI cron has not evaluated this contact yet. Signals refresh every Sunday 06:00 UTC.
        </Text>
      </EmptyState>
    );
  }

  return (
    <Tile>
      <Flex direction="column" gap="medium">
        {channel ? (
          <Flex direction="row" gap="extra-small">
            <Tag variant="default">{channel}</Tag>
          </Flex>
        ) : null}

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
            <Text>{trajectory ? TRAJECTORY_LABEL[trajectory] || trajectory : '—'}</Text>
          </LabeledRow>
        </Flex>

        <Divider />

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

        <Flex direction="column" gap="extra-small">
          <LabeledRow label="Last login">
            <Text>{formatRelativeAndAbsolute(lastLogin)}</Text>
          </LabeledRow>
          <LabeledRow label="Days since last post">
            <Text>{daysSincePost ?? '—'}</Text>
          </LabeledRow>
          <LabeledRow label="Days until expiry">
            <Text>{formatExpiry(daysUntilExpiry)}</Text>
          </LabeledRow>
          {noShow != null && noShow > 0 ? (
            <LabeledRow label="No-shows so far">
              <Tag variant="warning">{noShow}</Tag>
            </LabeledRow>
          ) : null}
        </Flex>

        {customerId ? (
          <>
            <Divider />
            <Link href={`${LP_ADMIN_BASE}${customerId}`} external>
              Open customer in LaunchPad admin
            </Link>
          </>
        ) : null}

        <Text variant="microcopy">
          Rejig data as of {formatFreshness(signalsObservedAt)}
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

function formatRelativeAndAbsolute(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
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

function formatFreshness(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const abs = d.toISOString().slice(0, 10);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return `today (${abs})`;
  if (days === 1) return `1 day ago (${abs})`;
  return `${days} days ago (${abs})`;
}
