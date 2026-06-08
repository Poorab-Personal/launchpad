/**
 * Slack alert on customer intake-submit.
 *
 * Single event per customer: fires from Auto 2 (handleTaskCompleted) when
 * the customer completes their intake-submit task:
 *
 *   D2C-Standard:           "Complete Your Onboarding Form"
 *   B2B-IPRE / Keyes / BW:  "Confirm Your Information"
 *
 * Why a single event tied to the task (not row-create / not HS-ticket-create):
 *
 *   - Row-create can be a system event (admin Add Customer, HubSpot deal
 *     closedwon, B2B landing-page email lookup) where the customer hasn't
 *     submitted anything yet. Caroline-Huo-shaped admin-adds would trigger a
 *     false signal.
 *   - HS-ticket-create is a system milestone, not a customer milestone.
 *   - The intake-submit task is the first moment a real human has put data
 *     in front of us. That's the moment worth alerting on.
 *
 * Suppression policy (mirrors the prior email-based notifier):
 *   - createdVia='backfill' → silent skip
 *   - environment includes 'test' → posted with [TEST] prefix
 *
 * Best-effort: errors logged, never thrown. Slack transport silently no-ops
 * when SLACK_WEBHOOK_URL is unset.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getSetting } from '@/lib/db';
import { postSlackMessage, type SlackBlock } from '@/lib/slack/post';

const HUBSPOT_PORTAL_ID = '44956899';

interface NextStep {
  next: string;
  court: string;
}

/**
 * What's next + whose court, per workflow, immediately after the intake-submit
 * task completes. Hardcoded vs. derived-from-templates to keep the alert copy
 * stable + readable, even as templates evolve. Audit when adding workflows.
 */
const INTAKE_SUBMIT_NEXT: Record<string, NextStep> = {
  'D2C-Standard': { next: 'Create Designs', court: 'Rejig' },
  'B2B-IPRE': { next: 'Capture Payment Method', court: 'Customer' },
  'B2B-Keyes': { next: 'Capture Payment Method', court: 'Customer' },
  'B2B-BW': { next: 'Schedule Onboarding Call + Create Designs', court: 'Customer + Rejig' },
};

export async function notifyCustomerSubmitted(customerId: string): Promise<void> {
  let customer: typeof schema.customers.$inferSelect | undefined;
  try {
    customer = await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
  } catch (err) {
    console.error(`[notifyCustomerSubmitted] customer lookup failed for ${customerId}:`, err);
    return;
  }
  if (!customer) {
    console.warn(`[notifyCustomerSubmitted] customer ${customerId} not found; skipping`);
    return;
  }
  if (customer.createdVia === 'backfill') {
    console.log(`[notifyCustomerSubmitted] backfill customer ${customerId}; skipping`);
    return;
  }

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
  const hubspotTicketUrl = customer.hubspotTicketId
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-5/${customer.hubspotTicketId}`
    : null;
  const stripeCustomerUrl = customer.stripeCustomerId
    ? `https://dashboard.stripe.com/customers/${customer.stripeCustomerId}`
    : null;

  const isTest = (customer.environment ?? []).includes('test');
  const prefix = isTest ? '[TEST] ' : '';
  const nextStep = INTAKE_SUBMIT_NEXT[customer.workflowKey] ?? { next: '—', court: '—' };

  // Line 1: header — bold name, workflow, optional brokerage
  const brokerageSuffix = brokerageName ? `  ·  ${brokerageName}` : '';
  const headerLine = `🔔  *${prefix}${customer.name}*  —  ${customer.workflowKey}${brokerageSuffix}`;

  // Line 2: compact contact info (omit absent fields, not em-dashes)
  const contactParts: string[] = [];
  if (customer.contactEmail) contactParts.push(customer.contactEmail);
  if (customer.phone) contactParts.push(customer.phone);
  const nonDefaultEnv = (customer.environment ?? []).filter((e) => e !== 'test');
  if (nonDefaultEnv.length) contactParts.push(`env: ${nonDefaultEnv.join(', ')}`);
  const contactLine = contactParts.length ? contactParts.join('  ·  ') : null;

  // Line 3: next action + court
  const nextLine = `*Next:* ${nextStep.next}  _(${nextStep.court})_`;

  // Line 4: clickable links (em-dash when unavailable)
  const linkParts = [
    `<${workspaceUrl}|LaunchPad>`,
    hubspotTicketUrl ? `<${hubspotTicketUrl}|HubSpot>` : '—',
    stripeCustomerUrl ? `<${stripeCustomerUrl}|Stripe>` : '—',
  ];
  const linkLine = linkParts.join('  ·  ');

  const mrkdwn = [headerLine, contactLine, nextLine, linkLine].filter(Boolean).join('\n');

  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: mrkdwn } },
  ];

  // Notification fallback — what shows up in Slack notifications/lists
  const fallback = `${prefix}New intake: ${customer.name} (${customer.workflowKey}) — next: ${nextStep.next}`;

  try {
    await postSlackMessage({ text: fallback, blocks });
  } catch (err) {
    console.error(`[notifyCustomerSubmitted] post failed for ${customerId}:`, err);
  }
}
