import { Heading, Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface CredentialsSentProps {
  firstName: string;
  portalUrl: string;
  platformEmail: string;
  password: string;
}

export default function CredentialsSentEmail({
  firstName,
  portalUrl,
  platformEmail,
  password,
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
        Your Rejig account is live and ready to go. Use the credentials below
        to sign in for the first time — we recommend changing your password
        once you&apos;re in.
      </Text>

      <Section className="bg-[#F7F4EB] rounded-lg p-4 my-4">
        <Text className="text-[#1B2E35]/70 text-xs uppercase font-semibold m-0 mb-1">
          Your login email
        </Text>
        <Text className="text-[#1B2E35] text-sm font-medium m-0 mb-3 font-mono">
          {platformEmail}
        </Text>
        <Text className="text-[#1B2E35]/70 text-xs uppercase font-semibold m-0 mb-1">
          Temporary password
        </Text>
        <Text className="text-[#1B2E35] text-sm font-medium m-0 font-mono bg-white border border-[#E0DEE4] rounded px-2 py-1 inline-block">
          {password}
        </Text>
        <Text className="text-[#1B2E35]/60 text-xs m-0 mt-3">
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
  password: 'Tx9k2pQ7vMwL',
} satisfies CredentialsSentProps;
