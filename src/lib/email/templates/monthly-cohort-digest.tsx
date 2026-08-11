import { Heading, Section, Text } from '@react-email/components';
import * as React from 'react';
import type {
  BrokerageCohort,
  CohortRow,
  MonthlyCohortResult,
} from '@/lib/automations/monthly-cohort-digest';
import { REPORT_TIMEZONE } from '@/lib/automations/monthly-cohort-digest';
import { EmailLayout } from './_layout';

interface MonthlyCohortDigestProps {
  result: MonthlyCohortResult;
}

const BORDER = '#E0DEE4';
const INK = '#1B2E35';
const FLAG = '#a04000';

/** M/D — the year is already in the heading, so repeating it wastes width. */
function shortDate(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIMEZONE,
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

const cellStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: `1px solid ${BORDER}`,
  fontSize: '12px',
  color: INK,
  whiteSpace: 'nowrap',
  textAlign: 'left',
};

const headStyle: React.CSSProperties = {
  ...cellStyle,
  borderBottom: `2px solid ${BORDER}`,
  fontSize: '11px',
  fontWeight: 600,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

function CohortTable({ cohort }: { cohort: BrokerageCohort }) {
  // Milestone columns come from the workflow itself, so B&W (no payment
  // step) renders fewer columns than Keyes/IPRE without any special-casing.
  const milestoneLabels = cohort.rows[0]?.milestones.map((m) => m.label) ?? [];
  const showCall = cohort.rows.some((r) => r.callDate);
  const showSignIn = cohort.rows.some((r) => r.signedInAt);

  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr>
          <th style={headStyle}>Agent</th>
          <th style={headStyle}>Started</th>
          {milestoneLabels.map((label) => (
            <th key={label} style={headStyle}>
              {label}
            </th>
          ))}
          {showCall && <th style={headStyle}>Call</th>}
          {showSignIn && <th style={headStyle}>Signed in</th>}
          <th style={headStyle}>Reached</th>
        </tr>
      </thead>
      <tbody>
        {cohort.rows.map((row: CohortRow) => (
          <tr key={row.customerId}>
            <td style={cellStyle}>
              <span style={{ fontWeight: 600 }}>{row.customerName}</span>
              {row.officeName && (
                <span style={{ color: '#9ca3af', fontSize: '11px' }}>
                  {' '}
                  · {row.officeName}
                </span>
              )}
              <br />
              <span style={{ color: '#9ca3af', fontSize: '11px' }}>
                {row.contactEmail}
              </span>
            </td>
            <td style={cellStyle}>{shortDate(row.startedAt)}</td>
            {row.milestones.map((m) => (
              <td key={m.taskTitle} style={cellStyle}>
                {shortDate(m.completedAt)}
              </td>
            ))}
            {showCall && (
              <td style={cellStyle}>
                {shortDate(row.callDate)}
                {row.callDate && !row.callHeld && (
                  <span style={{ color: '#9ca3af', fontSize: '11px' }}> (upcoming)</span>
                )}
              </td>
            )}
            {showSignIn && <td style={cellStyle}>{shortDate(row.signedInAt)}</td>}
            <td style={cellStyle}>
              {row.stage}
              {row.hsOutcomeMissing && <span style={{ color: FLAG }}> *</span>}
              {row.isReturning && <span style={{ color: FLAG }}> †</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FunnelCounts({ cohort }: { cohort: BrokerageCohort }) {
  return (
    <table style={{ borderCollapse: 'collapse', marginBottom: '10px' }}>
      <tbody>
        <tr>
          {cohort.funnelLabels.map((label, i) => (
            <td
              key={label}
              style={{
                padding: '4px 14px 4px 0',
                fontSize: '12px',
                color: '#6b7280',
                whiteSpace: 'nowrap',
              }}
            >
              {label}{' '}
              <span style={{ color: INK, fontWeight: 700, fontSize: '14px' }}>
                {cohort.funnelCounts[i]}
              </span>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

export default function MonthlyCohortDigestEmail({ result }: MonthlyCohortDigestProps) {
  const { monthLabel, cohorts, totalNew } = result;
  const withRows = cohorts.filter((c) => c.rows.length > 0);
  const empty = cohorts.filter((c) => c.rows.length === 0);

  const anyOutcomeGap = withRows.some((c) => c.rows.some((r) => r.hsOutcomeMissing));
  const anyReturning = withRows.some((c) => c.rows.some((r) => r.isReturning));

  return (
    <EmailLayout wide preview={`${monthLabel} B2B signups — ${totalNew} new`}>
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-2">
        {monthLabel} — new B2B signups
      </Heading>
      <Text className="text-[#1B2E35]/70 text-sm m-0 mb-6">
        {totalNew} new customer{totalNew === 1 ? '' : 's'} across{' '}
        {withRows.length} brokerage{withRows.length === 1 ? '' : 's'}, with the date
        they reached each step. Dates are {REPORT_TIMEZONE.split('/')[1].replace('_', ' ')}{' '}
        time.
      </Text>

      {totalNew === 0 && (
        <Text className="text-[#1B2E35]/70 text-sm m-0">
          No new B2B signups in {monthLabel}.
        </Text>
      )}

      {withRows.map((cohort) => (
        <Section key={cohort.workflowKey} className="mb-8">
          <Heading
            as="h3"
            className="text-[#1B2E35] text-lg m-0 mt-2 mb-2 border-l-4 border-[#6C4AB6] pl-3"
          >
            {cohort.brokerageName} ({cohort.rows.length})
          </Heading>
          <FunnelCounts cohort={cohort} />
          <CohortTable cohort={cohort} />
        </Section>
      ))}

      {(anyOutcomeGap || anyReturning || empty.length > 0) && (
        <Section className="mt-6 pt-4 border-t border-[#E0DEE4]">
          {anyOutcomeGap && (
            <Text className="text-[#1B2E35]/70 text-xs m-0 mb-1">
              <span style={{ color: FLAG }}>*</span> Onboarding call has happened but
              the HubSpot ticket is still &ldquo;Onboarding Scheduled&rdquo; — the CSM
              never marked the meeting outcome.
            </Text>
          )}
          {anyReturning && (
            <Text className="text-[#1B2E35]/70 text-xs m-0 mb-1">
              <span style={{ color: FLAG }}>†</span> This email already had a customer
              record before this month — an existing customer re-entering the flow, not
              a new signup.
            </Text>
          )}
          {empty.length > 0 && (
            <Text className="text-[#1B2E35]/70 text-xs m-0 mb-1">
              No new signups: {empty.map((c) => c.brokerageName).join(', ')}.
            </Text>
          )}
        </Section>
      )}

      {result.unmappedMilestones.length > 0 && (
        <Section className="mt-4">
          <Text className="text-[#a04000] text-xs m-0">
            Unlabelled milestone task{result.unmappedMilestones.length === 1 ? '' : 's'}:{' '}
            {result.unmappedMilestones.join(', ')} — add to MILESTONE_LABELS in
            src/lib/automations/monthly-cohort-digest.ts.
          </Text>
        </Section>
      )}

      <Text className="text-[#1B2E35]/40 text-xs m-0 mt-6">
        LaunchPad data only. Someone onboarded entirely outside LaunchPad (a HubSpot
        ticket with no LP customer record) will not appear here.
      </Text>
    </EmailLayout>
  );
}
