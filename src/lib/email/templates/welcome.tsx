import { Heading, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface WelcomeProps {
  firstName: string;
  portalUrl: string;
}

export default function WelcomeEmail({ firstName, portalUrl }: WelcomeProps) {
  return (
    <EmailLayout
      preview="Welcome to Rejig — let's get you set up"
      portalUrl={portalUrl}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Welcome to Rejig, {firstName}!
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Thanks for joining. We&apos;re excited to start building your brand kit and
        getting your social media on autopilot.
      </Text>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Your onboarding portal is ready. Inside you&apos;ll fill out a quick form
        about your business, upload your photo and logo, and book your onboarding
        call with our team.
      </Text>

      <PortalButton portalUrl={portalUrl} label="Open your portal →" />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        Bookmark the link or keep this email — it&apos;s how you&apos;ll get back into
        your portal anytime.
      </Text>
    </EmailLayout>
  );
}

WelcomeEmail.PreviewProps = {
  firstName: 'Sarah',
  portalUrl: 'https://onboarding.rejig.ai/r/recXXXXXXXXXXXXXX',
} satisfies WelcomeProps;
