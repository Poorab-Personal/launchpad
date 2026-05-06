import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import * as React from 'react';

interface LayoutProps {
  preview: string;
  children: React.ReactNode;
  portalUrl?: string;
}

/**
 * Shared shell for every email — header brand, body slot, footer with portal link.
 * Portal link is also surfaced via the `portalUrl` prop so every email always
 * shows the customer's magic link in the footer (even if the body forgets to).
 */
export function EmailLayout({ preview, children, portalUrl }: LayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-[#F7F4EB] font-sans">
          <Container className="max-w-[560px] mx-auto py-8 px-4">
            <Section className="mb-6">
              <Text className="text-[#6C4AB6] text-2xl font-bold tracking-tight m-0">
                Rejig.ai
              </Text>
            </Section>

            <Section className="bg-white rounded-xl p-8 shadow-sm">
              {children}
            </Section>

            <Hr className="border-[#E0DEE4] my-6" />

            <Section className="text-center">
              {portalUrl && (
                <Text className="text-[#1B2E35]/60 text-xs m-0 mb-2">
                  Your portal link:{' '}
                  <Link href={portalUrl} className="text-[#6C4AB6] underline break-all">
                    {portalUrl}
                  </Link>
                </Text>
              )}
              <Text className="text-[#1B2E35]/40 text-xs m-0">
                Sent by Rejig.ai Success Team. Reply to this email if you need help.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

/**
 * Reusable primary CTA button that works in Gmail, Outlook, etc.
 */
export function PortalButton({ portalUrl, label }: { portalUrl: string; label: string }) {
  return (
    <Section className="my-6 text-center">
      <Link
        href={portalUrl}
        className="bg-[#05C68E] text-white px-8 py-3 rounded-full text-sm font-semibold no-underline inline-block"
      >
        {label}
      </Link>
    </Section>
  );
}
