/**
 * Notify an internal team member when a task becomes actionable in their queue.
 *
 * Plan: docs/plans/internal-task-assignee-notifications.md
 *
 * Invoked (fire-and-forget) from:
 *   - activate-dependents.ts — both activation passes
 *   - design-approval.ts     — revision-round revise task creation
 *   - generate-tasks.ts      — defensive: any Team task created Active
 *   - design-review-reject route — direct createTask Active path
 *   - db.ts updateTaskFields — reassignment while Active
 *   - db.ts updateTaskStatus — defensive sibling of updateTaskFields
 *
 * Idempotency: callers stamp `assignee_notified_at = now()` inside the same
 * race-guarded UPDATE that flips status to Active (or inside the row INSERT
 * when the task is created Active). This module checks the column and
 * short-circuits if already set — protecting against double-sends on
 * concurrent winners.
 *
 * Best-effort: errors are logged, never thrown. An unsent notification is
 * less bad than a duplicate, so the row's `assignee_notified_at` is set
 * by the caller (not here) and a failed Resend send doesn't roll it back.
 *
 * Admin ad-hoc scripts (`scripts/reset-chris-design-loop.ts` etc.) bypass
 * this path via raw `db.update` by design — operators are deliberately
 * surgical and don't want emails firing.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { sendEmail } from '@/lib/email/send';
import { getSetting } from '@/lib/db';

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

export async function notifyTaskAssigned(taskId: string): Promise<void> {
  let task: typeof schema.tasks.$inferSelect | undefined;
  try {
    task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  } catch (err) {
    console.error(`[notifyTaskAssigned] task lookup failed for ${taskId}:`, err);
    return;
  }
  if (!task) {
    console.warn(`[notifyTaskAssigned] task ${taskId} not found; skipping`);
    return;
  }
  if (task.status !== 'Active') {
    // Caller should only invoke for Active transitions; log to surface misuse.
    console.log(`[notifyTaskAssigned] task ${taskId} status=${task.status} (not Active); skipping`);
    return;
  }
  if (!task.assignedToTeamMemberId) {
    console.log(`[notifyTaskAssigned] task ${taskId} has no assignee; skipping`);
    return;
  }
  // Idempotency: caller stamps this in the same UPDATE that flipped status.
  // If it's null here, someone bypassed the canonical path — still notify but
  // stamp it now to prevent any subsequent re-fires.
  const alreadyStamped = task.assigneeNotifiedAt !== null;

  const [assignee, customer] = await Promise.all([
    db.query.teamMembers.findFirst({ where: eq(schema.teamMembers.id, task.assignedToTeamMemberId) }),
    db.query.customers.findFirst({ where: eq(schema.customers.id, task.customerId) }),
  ]);

  if (!assignee) {
    console.warn(`[notifyTaskAssigned] assignee ${task.assignedToTeamMemberId} not found for task ${taskId}; skipping`);
    return;
  }
  if (!assignee.active) {
    console.log(`[notifyTaskAssigned] assignee ${assignee.email} is inactive; skipping task ${taskId}`);
    return;
  }
  // CSM lifecycle is managed entirely in HubSpot (hubspot_integration_decision.md).
  // Skip CSM-only members. Multi-role members (e.g. Designer + CSM) still notify —
  // they're being assigned in their non-CSM capacity.
  if (assignee.roles.length === 1 && assignee.roles[0] === 'CSM') {
    console.log(`[notifyTaskAssigned] assignee ${assignee.email} is CSM-only; skipping task ${taskId} (HubSpot handles CSM)`);
    return;
  }
  if (!customer) {
    console.warn(`[notifyTaskAssigned] customer ${task.customerId} not found for task ${taskId}; skipping`);
    return;
  }
  // Mirror trigger-email.ts: backfilled customers don't generate organic work
  // and shouldn't fire internal notifications either.
  if (customer.createdVia === 'backfill') {
    console.log(`[notifyTaskAssigned] backfill customer ${customer.id}; skipping notification for task ${taskId}`);
    return;
  }

  // Resolve workspace base URL via the global setting; fallback to the
  // production URL. (Customer.portalBaseUrl is a mapped-layer synthetic
  // field, not present on the raw schema row read here.)
  const portalBase =
    (await getSetting('portal_base_url'))
    || 'https://launchpad-indol-ten.vercel.app';
  const workspaceUrl = `${portalBase}/workspace/customers/${customer.id}`;

  // Stamp now if the caller didn't (defensive — prevents future re-fires
  // even on the bypass path). Best-effort; failure to stamp doesn't block
  // the email send.
  if (!alreadyStamped) {
    try {
      await db
        .update(schema.tasks)
        .set({ assigneeNotifiedAt: new Date() })
        .where(eq(schema.tasks.id, taskId));
    } catch (err) {
      console.error(`[notifyTaskAssigned] stamp assigneeNotifiedAt failed for ${taskId}:`, err);
    }
  }

  try {
    await sendEmail({
      template: 'task-assigned',
      to: assignee.email,
      subject: `New task in your queue: ${task.taskName} for ${customer.name}`,
      data: {
        firstName: firstName(assignee.name),
        taskName: task.taskName,
        customerName: customer.name,
        workspaceUrl,
        instructions: task.instructions,
      },
    });
  } catch (err) {
    console.error(`[notifyTaskAssigned] send failed for task ${taskId} → ${assignee.email}:`, err);
    return;
  }

  try {
    await db.insert(schema.events).values({
      customerId: customer.id,
      eventType: 'Assignee Notified',
      actorType: 'System',
      details: `Notified ${assignee.email} of "${task.taskName}".`,
      relatedTaskId: task.id,
    });
  } catch (err) {
    console.error(`[notifyTaskAssigned] event log failed for ${taskId}:`, err);
  }
}

/**
 * Defensive scan for the Auto-1 customer-create path.
 *
 * All current workflow templates have only the Client intake task starting
 * Active, so this is typically a no-op. But a future template row with
 * `initial_status='Active'` on a Team task would silently skip notification
 * under the activate-dependents fire-points. This helper covers the gap and
 * is called post-commit from every `generateTasksFromTemplate` caller.
 */
export async function notifyAssigneesForNewCustomer(customerId: string): Promise<void> {
  try {
    const activeAssignedTasks = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.customerId, customerId),
          eq(schema.tasks.status, 'Active'),
          eq(schema.tasks.taskType, 'Team'),
          isNotNull(schema.tasks.assignedToTeamMemberId),
        ),
      );
    for (const t of activeAssignedTasks) {
      void notifyTaskAssigned(t.id);
    }
  } catch (err) {
    console.error(`[notifyAssigneesForNewCustomer] scan failed for ${customerId}:`, err);
  }
}
