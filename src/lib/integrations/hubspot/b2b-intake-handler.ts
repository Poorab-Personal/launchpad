/**
 * B2B HubSpot push — runs after a B2B customer is created in LaunchPad
 * (admin Add Customer today; future brokerage landing pages later).
 *
 * Object graph created in HubSpot:
 *
 *   Company (brokerage, pre-existing)
 *     ├── Enterprise Deal (pre-existing, untouched per-agent)
 *     ├── Contact (this agent — NEW unless already in HS)
 *     │     {email, name, phone, launchpad_customer_id,
 *     │      rejig_brokerage_channel, rejig_payment_mode}
 *     └── Ticket (NEW)
 *           {subject: "{name} - LP", stage: Pre-Onboarding}
 *           also associated to: Contact + Company
 *
 * Per docs/integrations/hubspot-integration.md + the B2B object-graph
 * discussion 2026-05-14: Contact and Ticket associate to the Company.
 * Neither associates to the enterprise Deal (keeps the Deal clean for the
 * AE / billing view; per-agent traceability is via Company).
 *
 * Best-effort. Errors are logged but don't blow up the customer creation
 * response — the LP Customer + Tasks already landed.
 *
 * Idempotent: skips if customer.hubspotTicketId is already set (a previous
 * run partially succeeded; we just resume).
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  createContact,
  createCustomerJourneyTicket,
  ensureContactCompanyAssociation,
  findContactByEmail,
  updateContactProperties,
} from './client';

// Maps LP channel code → HubSpot enum INTERNAL value for rejig_brokerage_channel.
// HubSpot enum properties take the lowercase snake_case INTERNAL value, NOT
// the display label.
const CHANNEL_CODE_TO_HUBSPOT_ENUM: Record<string, string> = {
  Keyes: 'b2b_keyes',
  BW: 'b2b_bw',
  Standard: 'd2c',                          // not used in B2B path but kept for completeness
};

export type B2BIntakeResult =
  | { kind: 'pushed'; contactId: string; ticketId: string; contactWasNew: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: string };

export async function pushB2BCustomerToHubSpot(customerId: string): Promise<B2BIntakeResult> {
  // ─── 1. Read customer + brokerage + workflow template ─────────────────
  const customer = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
  });
  if (!customer) return { kind: 'error', error: 'Customer not found' };

  if (customer.type !== 'B2B') {
    return { kind: 'skipped', reason: 'customer is not B2B' };
  }

  // Resume: ticket already pushed
  if (customer.hubspotTicketId) {
    return { kind: 'skipped', reason: `already has hubspotTicketId=${customer.hubspotTicketId}` };
  }

  if (!customer.brokerageId) {
    return { kind: 'error', error: 'B2B customer has no brokerageId — cannot resolve target Company' };
  }

  const brokerage = await db.query.brokerages.findFirst({
    where: eq(schema.brokerages.id, customer.brokerageId),
    columns: { id: true, name: true, hubspotCompanyId: true },
  });
  if (!brokerage) return { kind: 'error', error: `Brokerage ${customer.brokerageId} not found` };

  if (!brokerage.hubspotCompanyId) {
    return {
      kind: 'error',
      error: `Brokerage ${brokerage.name} has no hubspotCompanyId — set it via scripts/seed-brokerage-hubspot-company-ids.ts or in the brokerages table`,
    };
  }

  // Channel code → HubSpot enum value
  const channelRow = await db.query.channels.findFirst({
    where: eq(schema.channels.id, customer.channelId),
    columns: { code: true },
  });
  const hubspotBrokerageChannel = CHANNEL_CODE_TO_HUBSPOT_ENUM[channelRow?.code ?? ''] ?? null;
  if (!hubspotBrokerageChannel) {
    return {
      kind: 'error',
      error: `Channel code ${channelRow?.code} has no rejig_brokerage_channel HubSpot mapping`,
    };
  }

  // Payment mode (drives HS Workflow A's trial-activation branch)
  const templates = await db.query.workflowTemplates.findMany({
    where: (t, { eq: eqOp }) => eqOp(t.workflowKey, customer.workflowKey),
    columns: { paymentMode: true },
    limit: 1,
  });
  const paymentMode = templates[0]?.paymentMode ?? 'pre-paid';

  // ─── 2. Find or create the agent Contact in HubSpot ───────────────────
  const email = customer.contactEmail ?? customer.platformEmail;
  if (!email) return { kind: 'error', error: 'Customer has no email — cannot find/create HS Contact' };

  const nameParts = customer.name.split(' ');
  const firstName = nameParts[0] ?? null;
  const lastName = nameParts.slice(1).join(' ') || null;

  let contactId: string | null = null;
  let contactWasNew = false;
  try {
    const existingId = await findContactByEmail(email);
    if (existingId) {
      contactId = existingId;
      // Make sure the existing Contact is on this brokerage's Company.
      await ensureContactCompanyAssociation(contactId, brokerage.hubspotCompanyId);
    } else {
      const created = await createContact({
        email,
        firstName,
        lastName,
        phone: customer.phone ?? null,
        companyId: brokerage.hubspotCompanyId,
      });
      contactId = created.contactId;
      contactWasNew = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: `Contact find/create failed: ${msg}` };
  }

  // ─── 3. Set Contact properties (LaunchPad anchors + BI signals) ───────
  try {
    await updateContactProperties(contactId, {
      launchpad_customer_id: customer.id,
      rejig_brokerage_channel: hubspotBrokerageChannel,
      rejig_payment_mode: paymentMode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[B2B HS push] Contact property update failed for ${contactId} (non-blocking)`, msg);
  }

  // ─── 4. Create the Customer Journey Ticket ────────────────────────────
  let ticketId: string;
  try {
    const created = await createCustomerJourneyTicket({
      subject: `${customer.name} - LP`,
      stageLabel: 'Pre-Onboarding',
      contactId,
      companyId: brokerage.hubspotCompanyId,           // NO dealId — B2B doesn't associate to the enterprise Deal
    });
    ticketId = created.ticketId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: `Ticket create failed: ${msg}` };
  }

  // ─── 5. Persist HS ids on LP customer for idempotency + cross-link ────
  await db
    .update(schema.customers)
    .set({
      hubspotContactId: contactId,
      hubspotTicketId: ticketId,
    })
    .where(eq(schema.customers.id, customer.id));

  console.log(`[B2B HS push] customer=${customer.id} → contact=${contactId} (new=${contactWasNew}) → ticket=${ticketId} (company=${brokerage.hubspotCompanyId})`);

  return { kind: 'pushed', contactId, ticketId, contactWasNew };
}
