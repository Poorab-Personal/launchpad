/**
 * Mid-round design-review correspondence — designer ↔ customer.
 *
 * Both handlers append to the customers.designNotes trail via appendDesignNote
 * (a plain jsonb UPDATE) and fire a best-effort notification. They deliberately
 * do NOT touch task status / updateTaskStatus, so a message can never fire
 * Auto-2 (dependent activation / stage advance). The conversation stays in the
 * same review stage. See docs/plans/design-review-messaging.md.
 */
import {
  appendDesignNote,
  getCustomerById,
  getTasksForCustomer,
  getTeamMemberById,
} from '@/lib/db';
import { sendEmail, sendAlertEmail } from '@/lib/email/send';
import type { InternalNoteAttachment, Task } from '@/types';

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

function preview(body: string, max = 200): string | null {
  const t = body.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/** Design-team tasks — used to find who's actively working the design so a
 *  customer reply pings the right person. */
function isDesignTask(name: string): boolean {
  return (
    name === 'Create Designs' ||
    name === 'Review Designs' ||
    name === 'Upload Proof to Customer' ||
    /^(Revise Design|Review Revision|Upload Revised Proof) \(/i.test(name)
  );
}

/**
 * Team member sends a message to the customer. Appends to the trail as a
 * 'designer' note, then emails the customer a "you have a new message" nudge
 * (best-effort; suppressed for backfill / no-email customers, mirroring
 * triggerCustomerEmail).
 */
export async function handleTeamDesignMessage(args: {
  customerId: string;
  authorId: string;
  body: string;
  attachments: InternalNoteAttachment[];
}): Promise<void> {
  const author = await getTeamMemberById(args.authorId);

  await appendDesignNote({
    customerId: args.customerId,
    from: 'designer',
    body: args.body,
    uploadTask: null, // free-form message, not a round upload
    attachments: args.attachments,
    authorName: author?.name ?? null,
  });

  // Notify the customer by email (best-effort).
  try {
    const customer = await getCustomerById(args.customerId);
    if (!customer) return;
    if (customer.createdVia === 'backfill') return;
    if (!customer.contactEmail) return;

    const portalBase = customer.portalBaseUrl || 'https://onboarding.rejig.ai';
    const portalUrl = `${portalBase}/r/${customer.accessToken}`;
    await sendEmail({
      template: 'new-message',
      to: customer.contactEmail,
      data: {
        firstName: firstName(customer.name),
        portalUrl,
        senderName: author?.name ?? null,
        messagePreview: preview(args.body),
      },
    });
  } catch (err) {
    console.error(`[handleTeamDesignMessage] email failed for ${args.customerId}:`, err);
  }
}

/**
 * Customer replies from the portal. Appends to the trail as a 'customer' note,
 * then notifies the design team (email + Slack, best-effort). Never blocks on a
 * notification failure.
 */
export async function handleCustomerDesignMessage(args: {
  customerId: string;
  body: string;
  attachments: InternalNoteAttachment[];
}): Promise<void> {
  const customer = await getCustomerById(args.customerId);
  if (!customer) throw new Error(`Customer ${args.customerId} not found`);

  await appendDesignNote({
    customerId: args.customerId,
    from: 'customer',
    body: args.body,
    uploadTask: null,
    attachments: args.attachments,
    authorName: customer.name,
  });

  // Resolve who to notify: the assignee of the active design task, falling
  // back to the customer's CSM.
  let tasks: Task[] = [];
  try {
    tasks = await getTasksForCustomer(args.customerId);
  } catch {
    tasks = [];
  }
  const activeDesignAssignee = tasks
    .filter((t) => t.status === 'Active' && isDesignTask(t.taskName))
    .flatMap((t) => t.assignedTo)[0];
  const targetId = activeDesignAssignee ?? customer.csmAssigned[0] ?? null;
  const target = targetId ? await getTeamMemberById(targetId) : null;

  const portalBase = customer.portalBaseUrl || 'https://onboarding.rejig.ai';
  const workspaceUrl = `${portalBase}/workspace/customers/${customer.id}`;
  const body = preview(args.body, 400) ?? '(no text — attachment only)';
  const attachNote = args.attachments.length
    ? `\n\n(${args.attachments.length} attachment${args.attachments.length === 1 ? '' : 's'})`
    : '';

  // Email the resolved team member (best-effort). No Slack ping — the shared
  // Slack channel is reserved for the existing new-submission alert.
  if (target?.email) {
    try {
      await sendAlertEmail({
        to: target.email,
        subject: `[LaunchPad] ${customer.name} replied about their designs`,
        text: `${customer.name} sent a message in the design review:\n\n"${body}"${attachNote}\n\nReply in LaunchPad: ${workspaceUrl}`,
      });
    } catch (err) {
      console.error(`[handleCustomerDesignMessage] email failed for ${args.customerId}:`, err);
    }
  }
}
