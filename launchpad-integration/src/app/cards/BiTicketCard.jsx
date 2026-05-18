import React from 'react';
import {
  hubspot,
  Text,
  Flex,
  Tile,
  Divider,
  LoadingSpinner,
  Tag,
  EmptyState,
} from '@hubspot/ui-extensions';
import { useCrmProperties } from '@hubspot/ui-extensions/crm';

const PROPS = [
  'hs_pipeline_stage',
  'rejig_attention_reason',
  'rejig_attention_set_at',
  'rejig_recommended_action',
  'rejig_recommended_action_urgency',
  'rejig_recommended_action_set_at',
];

// Mirrors src/lib/bi/types.ts AttentionReason (10 locked values).
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

// HS Customer Journey pipeline (hs_pipeline=0) stage internal IDs → labels.
// Snapshot via scripts/get-hs-stages.ts on 2026-05-18. Re-run that script if
// stages are added/renamed in the HubSpot UI.
const STAGE_LABEL = {
  '1360257164': 'Pre-Onboarding',
  '1154519671': 'Intake Pending',
  '1154519672': 'Design In Progress',
  '1154519673': 'Approval Pending',
  '1154519674': 'Onboarding Scheduled',
  '1165504776': 'Onboarded — Partially',
  '1154519675': 'Onboarding Completed',
  '1165493807': 'Check-in 1 Outreach',
  '1154519676': 'Check-in 1 Scheduled',
  '1154519677': 'Check-in 1 Completed',
  '1165495944': 'Check-in 2 Outreach',
  '1154519678': 'Check-in 2 Scheduled',
  '1154519679': 'Check-in 2 Completed',
  '1162370855': 'Pre-renewal Outreach',
  '1154519680': 'Pre-renewal Scheduled',
  '1154519681': 'Pre-renewal Completed',
  '1154519682': 'Active',
  '1360257165': 'Watch',
  '1154519683': 'At Risk',
  '1360257166': 'Critical',
  '1154519684': 'Churned',
  '1154519685': 'Lost — Non-Churn',
  '1360257167': 'On Hold',
};

// Mirrors src/lib/bi/types.ts ActionUrgency.
const URGENCY_LABEL = {
  today: 'TODAY',
  this_week: 'THIS WEEK',
  monitor: 'MONITOR',
};

const URGENCY_VARIANT = {
  today: 'danger',
  this_week: 'warning',
  monitor: 'default',
};

hubspot.extend(() => <BiTicketCard />);

function BiTicketCard() {
  const { properties, isLoading, error } = useCrmProperties(PROPS);

  if (isLoading) return <LoadingSpinner label="Loading Rejig BI…" />;
  if (error) return <Text variant="microcopy">Couldn't load Rejig BI.</Text>;

  const p = properties || {};
  const stage = p.hs_pipeline_stage;
  const reason = p.rejig_attention_reason;
  const reasonSetAt = p.rejig_attention_set_at;
  const action = p.rejig_recommended_action;
  const urgency = p.rejig_recommended_action_urgency;
  const actionSetAt = p.rejig_recommended_action_set_at;

  const hasAny = reason || action;

  if (!hasAny) {
    return (
      <EmptyState title="No attention signal" layout="vertical">
        <Text variant="microcopy">
          This ticket is not currently flagged by the BI cron. Signals refresh every Sunday 06:00 UTC.
        </Text>
      </EmptyState>
    );
  }

  return (
    <Tile>
      <Flex direction="column" gap="medium">
        <Flex direction="column" gap="extra-small">
          {stage ? (
            <LabeledRow label="Stage">
              <Text>{STAGE_LABEL[stage] || stage}</Text>
            </LabeledRow>
          ) : null}
          <LabeledRow label="Reason">
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
        </Flex>

        {action ? (
          <>
            <Divider />
            <Flex direction="column" gap="extra-small">
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
            </Flex>
          </>
        ) : null}
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

// HubSpot returns datetime properties as Unix-ms numeric strings (e.g.
// "1779081154000") via useCrmProperties — `new Date(numericString)` parses
// that as an invalid date string. Detect digit-only strings and convert.
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
