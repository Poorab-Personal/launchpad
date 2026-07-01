import { Heading, Hr, Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import type {
  Section1Reason,
  Section1Row,
  Section2Row,
} from '@/lib/automations/daily-checks';
import { EmailLayout } from './_layout';

/**
 * HubSpot portal id — used to build deep links into ticket records so the
 * digest reader can click straight to the HS context. Sourced from the same
 * constant in src/app/api/webhooks/hubspot/route.ts.
 */
const HUBSPOT_PORTAL_ID = '44956899';

interface DailyDigestProps {
  digestDate: string; // YYYY-MM-DD for the preview / heading
  section1: Section1Row[];
  section2: Section2Row[];
}

const REASON_LABEL: Record<Section1Reason, string> = {
  'rejig-sub-null': 'No sub linked in Rejig',
  'wrong-sub-linked': 'Wrong sub linked in Rejig',
  'no-rejig-account': 'No Rejig account found for this email',
  'multiple-rejig-accounts': 'Multiple Rejig accounts share this email',
};

function hsTicketUrl(ticketId: string | null): string | null {
  if (!ticketId) return null;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-5/${ticketId}`;
}

function formatCallDate(d: Date): string {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function hoursSince(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / (60 * 60 * 1000));
}

export default function DailyDigestEmail({
  digestDate,
  section1,
  section2,
}: DailyDigestProps) {
  const total = section1.length + section2.length;
  return (
    <EmailLayout
      preview={`LaunchPad daily — ${total} item${total === 1 ? '' : 's'} need attention`}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-2">
        LaunchPad daily checks — {digestDate}
      </Heading>
      <Text className="text-[#1B2E35]/70 text-sm m-0 mb-6">
        {total === 0
          ? 'All clear. (You shouldn’t be receiving this — the cron skips send when empty.)'
          : `${section1.length} Stripe linking, ${section2.length} unmarked meeting outcome.`}
      </Text>

      {/* ──────── Section 1 ──────── */}
      <Heading
        as="h2"
        className="text-[#1B2E35] text-lg m-0 mt-2 mb-2 border-l-4 border-[#6C4AB6] pl-3"
      >
        Section 1 · Stripe sub needs linking in Rejig ({section1.length})
      </Heading>
      <Text className="text-[#1B2E35]/70 text-sm m-0 mb-4">
        LP created a trial Stripe sub when the CSM marked the HubSpot ticket
        Active. Copy each <strong>sub_… id</strong> below into the matching
        account inside Rejig admin.
      </Text>

      {section1.length === 0 ? (
        <Text className="text-[#1B2E35]/50 text-sm italic m-0 mb-6">
          No items.
        </Text>
      ) : (
        section1.map((r) => {
          const hsUrl = hsTicketUrl(r.hubspotTicketId);
          return (
            <Section
              key={r.customerId}
              className="rounded-lg border border-[#E0DEE4] bg-white px-4 py-3 mb-3"
            >
              <Text className="text-[#1B2E35] text-base font-semibold m-0 mb-1">
                {r.customerName}{' '}
                <span className="text-[#1B2E35]/50 text-xs font-normal">
                  · {r.workflowKey}
                </span>
              </Text>
              <Text className="text-[#1B2E35]/70 text-xs m-0 mb-1">
                {r.contactEmail}
                {r.platformEmail !== r.contactEmail
                  ? ` · platform: ${r.platformEmail}`
                  : ''}
              </Text>
              <Text className="text-[#B5651D] text-xs font-semibold uppercase tracking-wider m-0 mb-2">
                {REASON_LABEL[r.reason]}
              </Text>
              <Text className="text-[#1B2E35] text-sm font-mono m-0 mb-1">
                LP sub:{' '}
                <span className="bg-[#F1EDFE] px-1 rounded">{r.lpStripeSubId}</span>
              </Text>
              {r.rejigStripeSubId && (
                <Text className="text-[#1B2E35]/70 text-sm font-mono m-0 mb-1">
                  Rejig has: {r.rejigStripeSubId}
                </Text>
              )}
              {hsUrl && (
                <Text className="text-xs m-0 mt-1">
                  <Link href={hsUrl} className="text-[#6C4AB6] underline">
                    Open HubSpot ticket →
                  </Link>
                </Text>
              )}
            </Section>
          );
        })
      )}

      <Hr className="border-[#E0DEE4] my-6" />

      {/* ──────── Section 2 ──────── */}
      <Heading
        as="h2"
        className="text-[#1B2E35] text-lg m-0 mt-2 mb-2 border-l-4 border-[#B5651D] pl-3"
      >
        Section 2 · CSM didn’t mark onboarding outcome ({section2.length})
      </Heading>
      <Text className="text-[#1B2E35]/70 text-sm m-0 mb-4">
        Meeting was scheduled more than 18h ago but the HubSpot ticket is
        still in <strong>Onboarding Scheduled</strong>. Until it moves to
        Active, no Stripe sub gets created and the trial never starts. Nudge
        the CSM or mark the meeting outcome directly.
      </Text>

      {section2.length === 0 ? (
        <Text className="text-[#1B2E35]/50 text-sm italic m-0 mb-2">
          No items.
        </Text>
      ) : (
        section2.map((r) => {
          const hsUrl = hsTicketUrl(r.hubspotTicketId);
          const hrs = hoursSince(r.callDate);
          return (
            <Section
              key={r.customerId}
              className="rounded-lg border border-[#E0DEE4] bg-white px-4 py-3 mb-3"
            >
              <Text className="text-[#1B2E35] text-base font-semibold m-0 mb-1">
                {r.customerName}{' '}
                <span className="text-[#1B2E35]/50 text-xs font-normal">
                  · {r.brokerageName ?? r.workflowKey}
                </span>
              </Text>
              <Text className="text-[#1B2E35]/70 text-xs m-0 mb-1">
                {r.contactEmail}
                {r.platformEmail !== r.contactEmail
                  ? ` · platform: ${r.platformEmail}`
                  : ''}
              </Text>
              <Text className="text-[#1B2E35] text-sm m-0 mb-1">
                Scheduled: {formatCallDate(r.callDate)}{' '}
                <span className="text-[#B5651D] font-semibold">
                  ({hrs}h ago)
                </span>
              </Text>
              {hsUrl && (
                <Text className="text-xs m-0 mt-1">
                  <Link href={hsUrl} className="text-[#6C4AB6] underline">
                    Open HubSpot ticket →
                  </Link>
                </Text>
              )}
            </Section>
          );
        })
      )}
    </EmailLayout>
  );
}

DailyDigestEmail.PreviewProps = {
  digestDate: '2026-06-10',
  section1: [
    {
      customerId: '00000000-0000-0000-0000-000000000001',
      customerName: 'Jane Agent',
      contactEmail: 'jane@example.com',
      platformEmail: 'jane@example.com',
      workflowKey: 'B2B-IPRE',
      hubspotTicketId: '12345',
      lpStripeSubId: 'sub_1AbC2DeFgHiJkLmNoPqRsT',
      rejigStripeSubId: null,
      reason: 'rejig-sub-null',
    },
  ],
  section2: [
    {
      customerId: '00000000-0000-0000-0000-000000000002',
      customerName: 'John Realtor',
      contactEmail: 'john@example.com',
      platformEmail: 'john@example.com',
      workflowKey: 'B2B-Keyes',
      brokerageName: 'Keyes',
      hubspotTicketId: '67890',
      callDate: new Date(Date.now() - 22 * 60 * 60 * 1000),
    },
  ],
} satisfies DailyDigestProps;
