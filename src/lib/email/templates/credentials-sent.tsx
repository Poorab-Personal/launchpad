import { Heading, Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface CredentialsSentProps {
  firstName: string;
  portalUrl: string;
  platformEmail: string;
}

export default function CredentialsSentEmail({
  firstName,
  portalUrl,
  platformEmail,
}: CredentialsSentProps) {
  return (
    <EmailLayout
      preview="Your Rejig account is ready — let's book your onboarding call"
      portalUrl={portalUrl}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Your account is set up, {firstName}
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Your Rejig account is live and ready to go. You&apos;ll receive a separate
        email with your login details.
      </Text>

      <Section className="bg-[#F7F4EB] rounded-lg p-4 my-4">
        <Text className="text-[#1B2E35]/70 text-xs uppercase font-semibold m-0 mb-1">
          Your login email
        </Text>
        <Text className="text-[#1B2E35] text-sm font-medium m-0">
          {platformEmail}
        </Text>
        <Text className="text-[#1B2E35]/60 text-xs m-0 mt-2">
          Sign in at{' '}
          <Link href="https://app.rejig.ai" className="text-[#6C4AB6] underline">
            app.rejig.ai
          </Link>
        </Text>
      </Section>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Next step: book your onboarding call with our team. We&apos;ll walk you
        through the platform and answer any questions.
      </Text>

      <PortalButton portalUrl={portalUrl} label="Book your call →" />
    </EmailLayout>
  );
}

CredentialsSentEmail.PreviewProps = {
  firstName: 'Sarah',
  portalUrl: 'https://launchpad-indol-ten.vercel.app/r/recXXXXXXXXXXXXXX',
  platformEmail: 'sarah@example.com',
} satisfies CredentialsSentProps;
