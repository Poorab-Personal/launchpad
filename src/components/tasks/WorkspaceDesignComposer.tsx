'use client';

import { useRouter } from 'next/navigation';
import DesignMessageComposer from './DesignMessageComposer';
import { sendDesignMessageAction } from '@/app/workspace/customers/[id]/design-message-actions';
import type { InternalNoteAttachment } from '@/types';

/**
 * Workspace-side design-message composer. Uploads attachments via the
 * session-authorized notes sign route, then calls the sendDesignMessageAction
 * server action (which appends the note + emails the customer).
 */
export default function WorkspaceDesignComposer({ customerId }: { customerId: string }) {
  const router = useRouter();
  return (
    <DesignMessageComposer
      signUrl="/api/workspace/notes/sign"
      clientPayload={JSON.stringify({ customerId })}
      placeholder="Message the customer… (paste screenshots with ⌘+V)"
      sendLabel="Send Email"
      onSubmit={(args: { body: string; attachments: InternalNoteAttachment[] }) =>
        sendDesignMessageAction({ customerId, body: args.body, attachments: args.attachments })
      }
      onSent={() => router.refresh()}
    />
  );
}
