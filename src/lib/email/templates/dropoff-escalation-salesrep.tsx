import { Heading, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface DropoffEscalationSalesRepProps {
  salesRepEmail: string;
  customerName: string;
  customerEmail: string;
  taskName: string;
  daysStalled: number;
  portalUrl: string;
}

export default function DropoffEscalationSalesRepEmail({
  salesRepEmail,
  customerName,
  customerEmail,
  taskName,
  daysStalled,
  portalUrl,
}: DropoffEscalationSalesRepProps) {
  return (
    <EmailLayout preview={`${customerName} could use a nudge — stuck ${daysStalled} days`}>
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Hey {salesRepEmail}
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        <strong>{customerName}</strong> ({customerEmail}) has been stuck for{' '}
        {daysStalled} days on <strong>{taskName}</strong> in their onboarding
        portal. We&apos;ve sent them reminders, but a personal nudge from you
        as their rep often helps get things moving.
      </Text>

      <PortalButton portalUrl={portalUrl} label="View their portal →" />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        No action needed if you&apos;ve already been in touch with them.
      </Text>
    </EmailLayout>
  );
}

DropoffEscalationSalesRepEmail.PreviewProps = {
  salesRepEmail: 'rep@rejig.ai',
  customerName: 'Sarah Lee',
  customerEmail: 'sarah@example.com',
  taskName: 'Review & Approve Your Brand Kit',
  daysStalled: 8,
  portalUrl: 'https://onboarding.rejig.ai/r/00000000-0000-0000-0000-000000000000',
} satisfies DropoffEscalationSalesRepProps;
