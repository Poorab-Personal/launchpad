import { Heading, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';
import { customerCtaLabel } from './dropoff-cta-labels';

interface DropoffReminderCustomerProps {
  firstName: string;
  taskName: string;
  instructions?: string | null;
  portalUrl: string;
  isFinalReminder: boolean;
}

export default function DropoffReminderCustomerEmail({
  firstName,
  taskName,
  instructions,
  portalUrl,
  isFinalReminder,
}: DropoffReminderCustomerProps) {
  return (
    <EmailLayout
      preview={`You have a next step waiting: ${taskName}`}
      portalUrl={portalUrl}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Hi {firstName}, you have a next step waiting
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        {instructions && instructions.trim()
          ? instructions
          : `Your portal is waiting on you for the next step: ${taskName}.`}
      </Text>

      <PortalButton portalUrl={portalUrl} label={customerCtaLabel(taskName)} highlight />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        {isFinalReminder
          ? "This is the last reminder we'll send about this step."
          : 'This is an automated reminder.'}{' '}
        If you&apos;ve already taken care of it, you can ignore this email.
      </Text>
    </EmailLayout>
  );
}

DropoffReminderCustomerEmail.PreviewProps = {
  firstName: 'Sarah',
  taskName: 'Review & Approve Your Brand Kit',
  instructions: 'Your brand kit proof is ready — approve it or request changes.',
  portalUrl: 'https://onboarding.rejig.ai/r/00000000-0000-0000-0000-000000000000',
  isFinalReminder: false,
} satisfies DropoffReminderCustomerProps;
