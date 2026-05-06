import { Heading, Text, Link } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface MagicLinkProps {
  firstName: string;
  signInUrl: string;
}

export default function MagicLinkEmail({ firstName, signInUrl }: MagicLinkProps) {
  return (
    <EmailLayout preview="Your LaunchPad sign-in link">
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        Hi {firstName}, here&apos;s your sign-in link
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        Click the button below to sign in to LaunchPad. The link expires in
        15 minutes.
      </Text>

      <PortalButton portalUrl={signInUrl} label="Sign in to LaunchPad →" />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0 mb-2">
        Or copy and paste this URL into your browser:
      </Text>
      <Text className="text-[#6C4AB6] text-xs leading-relaxed m-0 break-all">
        <Link href={signInUrl} className="text-[#6C4AB6] underline break-all">
          {signInUrl}
        </Link>
      </Text>

      <Text className="text-[#1B2E35]/60 text-xs leading-relaxed m-0 mt-6">
        If you didn&apos;t request this email, you can safely ignore it.
      </Text>
    </EmailLayout>
  );
}

MagicLinkEmail.PreviewProps = {
  firstName: 'Kaushal',
  signInUrl:
    'https://launchpad-indol-ten.vercel.app/auth/verify?token=eyJhbGciOiJIUzI1NiJ9...',
} satisfies MagicLinkProps;
