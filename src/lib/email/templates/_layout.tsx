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
 *
 * `highlight` adds a soft glow ring around the button via box-shadow, for
 * emails where the single next action needs to visually dominate the page
 * (drop-off reminders). Opt-in and defaults off so every other email using
 * this component (welcome, design-ready, credentials-sent, task-assigned)
 * renders unchanged. Note: box-shadow doesn't render in Outlook desktop
 * (Word rendering engine) — degrades gracefully there to the plain button,
 * no breakage, just no glow for that client.
 */
export function PortalButton({
  portalUrl,
  label,
  highlight = false,
}: {
  portalUrl: string;
  label: string;
  highlight?: boolean;
}) {
  return (
    <Section className="my-6 text-center">
      <Link
        href={portalUrl}
        className={
          highlight
            ? 'bg-[#05C68E] text-white px-8 py-3 rounded-full text-base font-bold no-underline inline-block shadow-[0_0_0_6px_rgba(5,198,142,0.18),0_0_28px_rgba(5,198,142,0.5)]'
            : 'bg-[#05C68E] text-white px-8 py-3 rounded-full text-sm font-semibold no-underline inline-block'
        }
      >
        {label}
      </Link>
    </Section>
  );
}
