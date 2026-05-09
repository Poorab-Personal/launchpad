import { Heading, Section, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface CredentialsSentProps {
  firstName: string;
  portalUrl: string;
  platformEmail: string;
  password: string;
  /** Customer.Call Date if booked. Empty string when no call on file (rare; e.g. legacy customers). */
  callDate: string;
}

function formatCallDate(iso: string): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function CredentialsSentEmail({
  firstName,
  portalUrl,
  platformEmail,
  password,
  callDate,
}: CredentialsSentProps) {
  const formattedCall = formatCallDate(callDate);
  return (
    <EmailLayout
      preview="Your Rejig account is ready — prepare for your onboarding call"
      portalUrl={portalUrl}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Your Rejig account is ready, {firstName}
      </Heading>

      {formattedCall ? (
        <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
          Your onboarding call is on <strong>{formattedCall}</strong>.
        </Text>
      ) : (
        <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
          Your team is setting up your onboarding call.
        </Text>
      )}

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Take 15 minutes before your call to prepare. Open your portal — there&apos;s
        a quick setup video and a one-step sign-in to get you ready.
      </Text>

      <PortalButton portalUrl={portalUrl} label="Open your portal →" />

      <Section className="bg-[#F7F4EB] rounded-lg p-4 mt-6">
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
          You&apos;ll be prompted to set a new password on first sign in. Both
          credentials also live in your portal if you need them later.
        </Text>
      </Section>
    </EmailLayout>
  );
}

CredentialsSentEmail.PreviewProps = {
  firstName: 'Sarah',
  portalUrl: 'https://launchpad-indol-ten.vercel.app/r/recXXXXXXXXXXXXXX',
  platformEmail: 'sarah@example.com',
  password: 'Smith123!',
  callDate: '2026-05-15T14:00:00Z',
} satisfies CredentialsSentProps;
