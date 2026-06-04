/**
 * Internal alert when a new LaunchPad customer is created.
 *
 * Fires from all 3 customer-create paths:
 *   - POST /api/customers (admin form)
 *   - closedwon-handler.ts (HubSpot closedwon → LP, gated by isNewCustomer)
 *   - /api/agent-lookup (B2B self-serve landing, real + test paths)
 *
 * Necessary because:
 *   - B2B self-serve customers (IPRE / Keyes / BW) do NOT receive a welcome
 *     email at create (locked 2026-05-28). Without this alert, the team has
 *     no signal that a customer signed up via the brokerage landing page
 *     until they hit a downstream email trigger like design-ready.
 *   - The customer-facing email BCC catches D2C welcomes but misses this
 *     entire surface.
 *
 * Suppressed for backfill customers (mirrors triggerCustomerEmail's policy).
 * Test customers (environment=['test']) are NOT suppressed — the team wants
 * to see the test signal (name contains "TEST" so it's easy to filter).
 *
 * Best-effort: errors logged, never thrown.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { sendAlertEmail } from '@/lib/email/send';
import { getSetting } from '@/lib/db';

// TODO: swap to success@rejig.ai once the team is monitoring.
const CUSTOMER_CREATED_NOTIFY_TO = 'poorab@rejig.ai';

export async function notifyCustomerCreated(customerId: string): Promise<void> {
  let customer: typeof schema.customers.$inferSelect | undefined;
  try {
    customer = await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
  } catch (err) {
    console.error(`[notifyCustomerCreated] customer lookup failed for ${customerId}:`, err);
    return;
  }
  if (!customer) {
    console.warn(`[notifyCustomerCreated] customer ${customerId} not found; skipping`);
    return;
  }
  if (customer.createdVia === 'backfill') {
    console.log(`[notifyCustomerCreated] backfill customer ${customerId}; skipping`);
    return;
  }

  // Brokerage name (B2B) for richer context, optional.
  let brokerageName: string | null = null;
  if (customer.brokerageId) {
    const b = await db.query.brokerages.findFirst({
      where: eq(schema.brokerages.id, customer.brokerageId),
      columns: { name: true },
    });
    brokerageName = b?.name ?? null;
  }

  const portalBase =
    (await getSetting('portal_base_url'))
    || 'https://launchpad-indol-ten.vercel.app';
  const workspaceUrl = `${portalBase}/workspace/customers/${customer.id}`;

  const isTest = (customer.environment ?? []).includes('test');
  const subject = `${isTest ? '[TEST] ' : ''}New LaunchPad customer: ${customer.name}`;

  const lines = [
    `Name:        ${customer.name}`,
    `Email:       ${customer.contactEmail}`,
    `Type:        ${customer.type}`,
    `Workflow:    ${customer.workflowKey}`,
    brokerageName ? `Brokerage:   ${brokerageName}` : null,
    `Source:      ${customer.createdVia}`,
    `Stage:       ${customer.currentStage}`,
    customer.environment?.length ? `Environment: ${customer.environment.join(', ')}` : null,
    ``,
    `View in workspace: ${workspaceUrl}`,
  ].filter(Boolean) as string[];

  try {
    await sendAlertEmail({
      to: CUSTOMER_CREATED_NOTIFY_TO,
      subject,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error(`[notifyCustomerCreated] send failed for ${customerId}:`, err);
  }
}
