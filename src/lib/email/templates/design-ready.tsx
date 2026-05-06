import { Heading, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface DesignReadyProps {
  firstName: string;
  portalUrl: string;
}

export default function DesignReadyEmail({ firstName, portalUrl }: DesignReadyProps) {
  return (
    <EmailLayout
      preview="Your design proof is ready to review"
      portalUrl={portalUrl}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Your design proof is ready, {firstName}
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Our designers have created your brand kit. Take a look and either
        approve it (we&apos;ll move into production) or send back changes.
      </Text>

      <PortalButton portalUrl={portalUrl} label="Review your design →" />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        If you have feedback, you can request changes directly in the portal.
        Our team will revise and send a new proof for you to review.
      </Text>
    </EmailLayout>
  );
}

DesignReadyEmail.PreviewProps = {
  firstName: 'Sarah',
  portalUrl: 'https://launchpad-indol-ten.vercel.app/r/recXXXXXXXXXXXXXX',
} satisfies DesignReadyProps;
