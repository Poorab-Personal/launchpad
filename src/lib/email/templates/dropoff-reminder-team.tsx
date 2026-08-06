import { Heading, Section, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';
import { teamCtaLabel } from './dropoff-cta-labels';

interface DropoffReminderTeamProps {
  firstName: string;
  taskName: string;
  customerName: string;
  instructions?: string | null;
  workspaceUrl: string;
  isFinalReminder: boolean;
}

export default function DropoffReminderTeamEmail({
  firstName,
  taskName,
  customerName,
  instructions,
  workspaceUrl,
  isFinalReminder,
}: DropoffReminderTeamProps) {
  return (
    <EmailLayout preview={`Still open: ${taskName} for ${customerName}`}>
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Hi {firstName}, this one&apos;s still open
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        <strong>{taskName}</strong> for <strong>{customerName}</strong> has been
        sitting in your queue for a few days.
      </Text>

      {instructions && instructions.trim() && (
        <Section className="rounded-lg border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 px-4 py-3 mb-4">
          <Text className="text-[#6C4AB6] text-xs uppercase tracking-wider font-semibold m-0 mb-1">
            Instructions
          </Text>
          <Text className="text-[#1B2E35] text-sm leading-relaxed m-0 whitespace-pre-wrap">
            {instructions}
          </Text>
        </Section>
      )}

      <PortalButton portalUrl={workspaceUrl} label={teamCtaLabel(taskName)} highlight />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        {isFinalReminder
          ? "This is the last nudge we'll send on this one — flagging it to the team as well."
          : 'This is an automated reminder.'}{' '}
        If it&apos;s already done, you can ignore this email.
      </Text>
    </EmailLayout>
  );
}

DropoffReminderTeamEmail.PreviewProps = {
  firstName: 'Alex',
  taskName: 'Create Designs',
  customerName: 'Sarah Lee',
  instructions: 'Designer pulls assets and info from Customer record.',
  workspaceUrl: 'https://onboarding.rejig.ai/workspace/customers/00000000-0000-0000-0000-000000000000',
  isFinalReminder: false,
} satisfies DropoffReminderTeamProps;
