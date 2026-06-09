import { Heading, Section, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface TaskAssignedProps {
  firstName: string;
  taskName: string;
  customerName: string;
  workspaceUrl: string;
  instructions?: string | null;
}

export default function TaskAssignedEmail({
  firstName,
  taskName,
  customerName,
  workspaceUrl,
  instructions,
}: TaskAssignedProps) {
  return (
    <EmailLayout preview={`New task in your queue: ${taskName}`}>
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Hi {firstName}, a new task is in your queue
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        <strong>{taskName}</strong> for <strong>{customerName}</strong> is now
        active and assigned to you.
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

      <PortalButton portalUrl={workspaceUrl} label="Open in workspace →" />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        Reply to this email if you have any questions about this assignment.
      </Text>
    </EmailLayout>
  );
}

TaskAssignedEmail.PreviewProps = {
  firstName: 'Alex',
  taskName: 'Create Designs',
  customerName: 'Sarah Lee',
  workspaceUrl: 'https://onboarding.rejig.ai/workspace/customers/00000000-0000-0000-0000-000000000000',
  instructions: 'Designer pulls assets and info from Customer record.',
} satisfies TaskAssignedProps;
