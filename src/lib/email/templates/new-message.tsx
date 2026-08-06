import { Heading, Section, Text } from '@react-email/components';
import * as React from 'react';
import { EmailLayout, PortalButton } from './_layout';

interface NewMessageProps {
  firstName: string;
  portalUrl: string;
  /** Who sent it, if known (designer / team member name). */
  senderName?: string | null;
  /** Short preview of the message body. Optional. */
  messagePreview?: string | null;
}

export default function NewMessageEmail({
  firstName,
  portalUrl,
  senderName,
  messagePreview,
}: NewMessageProps) {
  const sender = senderName && senderName.trim() ? senderName : 'Your Rejig design team';
  return (
    <EmailLayout
      preview="You have a new message from your Rejig design team"
      portalUrl={portalUrl}
    >
      <Heading className="text-[#1B2E35] text-2xl m-0 mb-4">
        You have a new message, {firstName}
      </Heading>

      <Text className="text-[#1B2E35]/80 text-base leading-relaxed m-0 mb-4">
        {sender} sent you a message about your designs. Open your portal to read
        it, reply, or attach a file — everything stays in one place there.
      </Text>

      {messagePreview && messagePreview.trim() && (
        <Section className="rounded-lg border border-[#6C4AB6]/30 bg-[#6C4AB6]/5 px-4 py-3 mb-4">
          <Text className="text-[#6C4AB6] text-xs uppercase tracking-wider font-semibold m-0 mb-1">
            New message
          </Text>
          <Text className="text-[#1B2E35] text-sm leading-relaxed m-0 whitespace-pre-wrap">
            {messagePreview}
          </Text>
        </Section>
      )}

      <PortalButton portalUrl={portalUrl} label="Open your portal to reply →" />

      <Text className="text-[#1B2E35]/60 text-sm leading-relaxed m-0">
        Please don&apos;t reply to this email — reply from your portal instead so
        nothing gets lost and your designer sees it right away.
      </Text>
    </EmailLayout>
  );
}

NewMessageEmail.PreviewProps = {
  firstName: 'Sarah',
  portalUrl: 'https://onboarding.rejig.ai/r/recXXXXXXXXXXXXXX',
  senderName: 'Kaushal',
  messagePreview:
    'Happy to match your current material — go ahead and upload it right here in the portal and I’ll work it into the next round.',
} satisfies NewMessageProps;
