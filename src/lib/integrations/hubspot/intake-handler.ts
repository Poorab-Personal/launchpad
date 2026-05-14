/**
 * Customer intake HubSpot push — runs after a customer is created in LP
 * via admin Add Customer (or future brokerage landing pages). Handles
 * BOTH D2C and B2B types. The D2C closedwon path lives separately in
 * closedwon-handler.ts since it reads a pre-existing HS Deal.
 *
 * Object graphs:
 *
 *   B2B (Keyes / BW):
 *     Company (brokerage, pre-existing)
 *       ├── Enterprise Deal (pre-existing, untouched per-agent)
 *       ├── Contact (this agent — NEW unless already in HS)
 *       │     {launchpad_customer_id, rejig_brokerage_channel,
 *       │      rejig_payment_mode}
 *       └── Ticket (NEW, Pre-Onboarding)
 *             associated to: Contact + Company
 *
 *   D2C admin:
 *     (no Company)
 *       └── Contact (this agent — NEW unless already in HS)
 *             {launchpad_customer_id, rejig_brokerage_channel='d2c',
 *              rejig_payment_mode='pre-paid'}
 *             └── Ticket (NEW, Pre-Onboarding)
 *                   associated to: Contact only (no Company, no Deal)
 *
 * D2C admin is a testing shortcut + a fallback path; the canonical D2C
 * intake flow is the HubSpot Deal closedwon webhook (which handler reads
 * the existing Deal + Contact). Admin-created D2C customers don't have
 * a Deal — Ticket associates to Contact only.
 *
 * Best-effort. Errors logged but don't blow up the LP customer creation
 * response. Idempotent: skips if customer.hubspotTicketId is already set.
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
  Standard: 'd2c',
};

export type IntakePushResult =
  | { kind: 'pushed'; contactId: string; ticketId: string; contactWasNew: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: string };

export async function pushCustomerIntakeToHubSpot(customerId: string): Promise<IntakePushResult> {
  // ─── 1. Read customer + (B2B only) brokerage + workflow template ──────
  const customer = await db.query.customers.findFirst({
    where: eq(schema.customers.id, customerId),
  });
  if (!customer) return { kind: 'error', error: 'Customer not found' };

  // Resume: ticket already pushed
  if (customer.hubspotTicketId) {
    return { kind: 'skipped', reason: `already has hubspotTicketId=${customer.hubspotTicketId}` };
  }

  // Channel code → HubSpot enum value (mapping covers both D2C + B2B)
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

  // B2B-only: resolve brokerage Company. D2C skips this entirely.
  let companyId: string | undefined;
  if (customer.type === 'B2B') {
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
        error: `Brokerage ${brokerage.name} has no hubspotCompanyId — set it via scripts/seed-brokerage-hubspot-company-ids.ts`,
      };
    }
    companyId = brokerage.hubspotCompanyId;
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
      // For B2B, make sure the existing Contact is on the brokerage's Company.
      // For D2C, there's no Company to associate to — skip.
      if (companyId) {
        await ensureContactCompanyAssociation(contactId, companyId);
      }
    } else {
      const created = await createContact({
        email,
        firstName,
        lastName,
        phone: customer.phone ?? null,
        companyId,                             // undefined for D2C — createContact handles
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
    console.warn(`[HS intake] Contact property update failed for ${contactId} (non-blocking)`, msg);
  }

  // ─── 4. Create the Customer Journey Ticket ────────────────────────────
  let ticketId: string;
  try {
    const created = await createCustomerJourneyTicket({
      subject: `${customer.name} - LP`,
      stageLabel: 'Pre-Onboarding',
      contactId,
      companyId,                                // B2B only; undefined for D2C
                                                // NO dealId — both paths skip Deal association
                                                // (closedwon-handler associates to Deal separately)
    });
    ticketId = created.ticketId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: `Ticket create failed: ${msg}` };
  }

  // ─── 5. Persist HS ids + seed onboardingState on LP customer ──────────
  // The next stage move arrives via HubSpot webhook with a correct
  // from_state in customer_state_transitions instead of NULL (Phase 3).
  await db
    .update(schema.customers)
    .set({
      hubspotContactId: contactId,
      hubspotTicketId: ticketId,
      onboardingState: 'Pre-Onboarding',
    })
    .where(eq(schema.customers.id, customer.id));

  console.log(`[HS intake] customer=${customer.id} type=${customer.type} → contact=${contactId} (new=${contactWasNew}) → ticket=${ticketId}${companyId ? ` (company=${companyId})` : ''}`);

  return { kind: 'pushed', contactId, ticketId, contactWasNew };
}
