import { Heading, Section, Text } from '@react-email/components';
import * as React from 'react';
import type { B2BDigestRow } from '@/lib/automations/dropoff-b2b-digest';
import { EmailLayout } from './_layout';

interface DropoffB2BDigestProps {
  digestDate: string; // YYYY-MM-DD
  rows: B2BDigestRow[];
}

const TIER_LABEL: Record<number, string> = {
  1: 'Day 2+',
  2: 'Day 5+',
  3: 'Day 8+',
};

function groupByBrokerage(rows: B2BDigestRow[]): Map<string, B2BDigestRow[]> {
  const map = new Map<string, B2BDigestRow[]>();
  for (const row of rows) {
    const arr = map.get(row.brokerageName) ?? [];
    arr.push(row);
    map.set(row.brokerageName, arr);
  }
  return map;
}

export default function DropoffB2BDigestEmail({ digestDate, rows }: DropoffB2BDigestProps) {
  const grouped = groupByBrokerage(rows);
  const hotCount = rows.filter((r) => r.isHotCase).length;

  return (
    <EmailLayout preview={`B2B drop-off digest — ${rows.length} stalled (${digestDate})`}>
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-2">
        B2B drop-off digest — {digestDate}
      </Heading>
      <Text className="text-[#1B2E35]/70 text-sm m-0 mb-6">
        {rows.length} customer{rows.length === 1 ? '' : 's'} stalled 2+ days on a
        client task.
        {hotCount > 0 &&
          ` ${hotCount} highlighted below saved a card but haven't booked their onboarding call — worth prioritizing.`}
      </Text>

      {Array.from(grouped.entries()).map(([brokerageName, brokerageRows]) => (
        <Section key={brokerageName} className="mb-6">
          <Heading
            as="h3"
            className="text-[#1B2E35] text-lg m-0 mt-2 mb-2 border-l-4 border-[#6C4AB6] pl-3"
          >
            {brokerageName} ({brokerageRows.length})
          </Heading>
          {brokerageRows.map((row) => (
            <Section
              key={row.customerId}
              className={
                row.isHotCase
                  ? 'rounded-lg border border-[#e0a0a0] bg-[#fff5f5] px-4 py-3 mb-3'
                  : 'rounded-lg border border-[#E0DEE4] bg-white px-4 py-3 mb-3'
              }
            >
              <Text
                className={
                  row.isHotCase
                    ? 'text-[#a00] text-base font-semibold m-0 mb-1'
                    : 'text-[#1B2E35] text-base font-semibold m-0 mb-1'
                }
              >
                {row.customerName}{' '}
                <span className="text-[#1B2E35]/50 text-xs font-normal">
                  {row.contactEmail}
                </span>
              </Text>
              <Text className="text-[#1B2E35]/70 text-xs m-0 mb-1">
                Stuck on <strong>{row.taskName}</strong> — {row.daysStalled} days
                ({TIER_LABEL[row.tier] ?? `Day ${row.daysStalled}`})
              </Text>
              {row.isHotCase && (
                <Text className="text-[#a00] text-xs font-semibold uppercase tracking-wider m-0">
                  Card saved, call not booked
                </Text>
              )}
            </Section>
          ))}
        </Section>
      ))}
    </EmailLayout>
  );
}

DropoffB2BDigestEmail.PreviewProps = {
  digestDate: '2026-08-09',
  rows: [
    {
      customerId: '00000000-0000-0000-0000-000000000001',
      customerName: 'William Rafter',
      contactEmail: 'rrafter@ipre.com',
      brokerageName: 'IPRE',
      workflowKey: 'B2B-IPRE',
      taskName: 'Schedule Your Onboarding Call',
      daysStalled: 26,
      tier: 3,
      isHotCase: true,
    },
    {
      customerId: '00000000-0000-0000-0000-000000000002',
      customerName: 'Lynn Kirker',
      contactEmail: 'lkirker@ipre.com',
      brokerageName: 'IPRE',
      workflowKey: 'B2B-IPRE',
      taskName: 'Schedule Your Onboarding Call',
      daysStalled: 18,
      tier: 3,
      isHotCase: true,
    },
  ],
} satisfies DropoffB2BDigestProps;
