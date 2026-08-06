import { Heading, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface DropoffEscalationTeamProps {
  taskName: string;
  customerName: string;
  assigneeName: string;
  daysStalled: number;
  workspaceUrl: string;
}

export default function DropoffEscalationTeamEmail({
  taskName,
  customerName,
  assigneeName,
  daysStalled,
  workspaceUrl,
}: DropoffEscalationTeamProps) {
  return (
    <EmailLayout preview={`${taskName} for ${customerName} stuck ${daysStalled} days`}>
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Internal task stuck {daysStalled} days
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        <strong>{taskName}</strong> for <strong>{customerName}</strong> has
        been sitting Active in <strong>{assigneeName}</strong>&apos;s queue
        for {daysStalled} days despite reminders. Worth checking in.
      </Text>

      <PortalButton portalUrl={workspaceUrl} label="View in workspace →" />
    </EmailLayout>
  );
}

DropoffEscalationTeamEmail.PreviewProps = {
  taskName: 'Create Customer Account',
  customerName: 'Sarah Lee',
  assigneeName: 'Alex Ops',
  daysStalled: 8,
  workspaceUrl: 'https://onboarding.rejig.ai/workspace/customers/00000000-0000-0000-0000-000000000000',
} satisfies DropoffEscalationTeamProps;
