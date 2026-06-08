import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { generateTasksFromTemplate } from '@/lib/automations/generate-tasks';
import { triggerCustomerEmail } from '@/lib/automations/trigger-email';
import { notifyAssigneesForNewCustomer } from '@/lib/automations/notify-assignee';
import {
  createCustomerJourneyTicket,
  getDealForClosedWon,
  postNoteOnDeal,
  updateContactProperties,
  updateDealProperties,
} from './client';

/**
 * Orchestrates D2C customer creation when a HubSpot Deal moves to closedwon.
 *
 * Flow:
 *   1. Read Deal from HubSpot (with associated Contact + 3 sub_id properties + magic_link_email)
 *   2. Validate inputs (magic_link_email set, at least 1 sub_id present, Contact has email)
 *   3. For each non-null sub_id → look up Stripe Subscription + Customer; collect into list
 *   4. db.transaction: insert customers row + customer_subscriptions rows + generate tasks
 *   5. Send Welcome email via Resend (magic link)
 *   6. Update Stripe metadata: launchpad_customer_id, hubspot_contact_id, hubspot_deal_id
 *   7. Push to HubSpot: create Ticket in Pre-Onboarding + update Contact properties + Deal launchpad_customer_id
 *
 * On validation failure: post Note on Deal, throw — caller marks the inbound
 * event as 'error' with the message.
 */

const PRODUCT_KEY_TO_ENUM = {
  stripePaymentId: 'Core',
  voiceStripePaymentId: 'Voice',
  avatarStripePaymentId: 'Avatar',
} as const;

let _stripeClient: Stripe | null = null;
function stripe(): Stripe {
  if (_stripeClient) return _stripeClient;
  // D2C subs live in the LIVE Rejig Stripe account (created outside LP and
  // pasted into the HS deal as stripe_payment_id). The other LP Stripe paths
  // (B2B-Keyes SetupIntent, portal payment) use STRIPE_SECRET_KEY which
  // currently points at Keyes Sandbox. So this handler explicitly prefers
  // STRIPE_LIVE_SECRET_KEY; fall back to STRIPE_SECRET_KEY for local-dev
  // setups that only have one key. Until the Option A staging split lands,
  // closedwon is the one path that MUST hit live.
  const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_LIVE_SECRET_KEY (or STRIPE_SECRET_KEY) not set');
  _stripeClient = new Stripe(key);
  return _stripeClient;
}

export type ClosedWonResult = {
  customerId: string;
  hubspotContactId: string;
  hubspotDealId: string;
  hubspotTicketId: string;
  subscriptionsCreated: number;
};

export async function processDealClosedWon(dealId: string): Promise<ClosedWonResult> {
  // ─── 1. Read Deal + Contact ─────────────────────────────────────────────
  const deal = await getDealForClosedWon(dealId);

  // ─── 2. Validate ────────────────────────────────────────────────────────
  const errors: string[] = [];
  if (!deal.magicLinkEmail) errors.push('magic_link_email is empty');
  if (!deal.contactEmail) errors.push('associated Contact has no email');

  const subIdsByProduct: { key: keyof typeof PRODUCT_KEY_TO_ENUM; subId: string }[] = [];
  if (deal.stripePaymentId) subIdsByProduct.push({ key: 'stripePaymentId', subId: deal.stripePaymentId });
  if (deal.voiceStripePaymentId) subIdsByProduct.push({ key: 'voiceStripePaymentId', subId: deal.voiceStripePaymentId });
  if (deal.avatarStripePaymentId) subIdsByProduct.push({ key: 'avatarStripePaymentId', subId: deal.avatarStripePaymentId });

  if (subIdsByProduct.length === 0) {
    errors.push('no Stripe Subscription IDs set (need Core at minimum)');
  }

  for (const { subId } of subIdsByProduct) {
    if (!/^sub_[A-Za-z0-9_]+$/.test(subId)) {
      errors.push(`malformed subscription ID: ${subId}`);
    }
  }

  if (errors.length > 0) {
    const msg = `LaunchPad: cannot process closedwon — ${errors.join('; ')}.`;
    await postNoteOnDeal(dealId, msg);
    throw new Error(msg);
  }

  // ─── 3. Look up Stripe Subscriptions ────────────────────────────────────
  const sk = stripe();
  type SubLookup = {
    product: 'Core' | 'Voice' | 'Avatar';
    sub: Stripe.Subscription;
  };
  const subLookups: SubLookup[] = [];
  let stripeCustomerId: string | null = null;

  for (const { key, subId } of subIdsByProduct) {
    let sub: Stripe.Subscription;
    try {
      sub = await sk.subscriptions.retrieve(subId);
    } catch {
      const msg = `LaunchPad: Stripe subscription ${subId} not found.`;
      await postNoteOnDeal(dealId, msg);
      throw new Error(msg);
    }
    if (!['active', 'trialing'].includes(sub.status)) {
      const msg = `LaunchPad: Stripe subscription ${subId} status is "${sub.status}" — must be active or trialing.`;
      await postNoteOnDeal(dealId, msg);
      throw new Error(msg);
    }
    const cusId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    if (stripeCustomerId && stripeCustomerId !== cusId) {
      const msg = `LaunchPad: subscriptions belong to different Stripe customers (${stripeCustomerId} vs ${cusId}).`;
      await postNoteOnDeal(dealId, msg);
      throw new Error(msg);
    }
    stripeCustomerId = cusId;
    subLookups.push({ product: PRODUCT_KEY_TO_ENUM[key], sub });
  }

  if (!stripeCustomerId) throw new Error('Stripe customer not resolved');

  // ─── 4. Resume-or-create LaunchPad customer ─────────────────────────────
  // If a customer with this hubspot_contact_id already exists, we're resuming
  // a previous run that partially failed (e.g. between DB commit and HubSpot
  // push). Skip the insert + Welcome email + Stripe metadata steps; pick up
  // at the HubSpot push.
  const existingCustomer = await db.query.customers.findFirst({
    where: (customers, { eq: eqOp }) => eqOp(customers.hubspotContactId, deal.contactId),
  });

  let customer = existingCustomer ?? null;
  let isNewCustomer = false;

  if (!customer) {
    isNewCustomer = true;

    // D2C-Standard is the only D2C workflow today.
    const channelRow = await db.query.channels.findFirst({
      where: (channels, { eq: eqOp }) => eqOp(channels.code, 'Standard'),
    });
    if (!channelRow) {
      throw new Error('No "Standard" channel found in DB — required for D2C closedwon');
    }

    const customerName = [deal.contactFirstName, deal.contactLastName]
      .filter(Boolean)
      .join(' ')
      .trim() || deal.dealName || deal.contactEmail || 'Unknown';

    const firstSub = subLookups[0].sub;
    const subStatusMirror: 'Active' | 'Trial' = firstSub.status === 'trialing' ? 'Trial' : 'Active';

    customer = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.customers)
        .values({
          name: customerName,
          type: 'D2C',
          channelId: channelRow.id,
          workflowKey: 'D2C-Standard',
          contactEmail: deal.magicLinkEmail!,
          platformEmail: deal.contactEmail!,
          phone: deal.contactPhone ?? null,
          businessName: deal.contactCompany ?? null,
          currentStage: 'Getting Started',
          hubspotContactId: deal.contactId,
          hubspotDealId: deal.dealId,
          stripeCustomerId,
          stripeSubscriptionId: firstSub.id,
          subscriptionStatus: subStatusMirror,
          hasVoice: subLookups.some((s) => s.product === 'Voice'),
          hasAvatar: subLookups.some((s) => s.product === 'Avatar'),
        })
        .returning();

      await tx.insert(schema.customerSubscriptions).values(
        subLookups.map(({ product, sub }) => ({
          customerId: inserted.id,
          product,
          stripeSubscriptionId: sub.id,
          hubspotDealId: deal.dealId,
          status: mapStripeSubStatus(sub.status),
          startedAt: sub.start_date ? new Date(sub.start_date * 1000) : null,
          endedAt: sub.ended_at ? new Date(sub.ended_at * 1000) : null,
        })),
      );

      await generateTasksFromTemplate(tx, {
        customerId: inserted.id,
        type: inserted.type,
        channel: 'Standard',
        brokerageId: null,
        hasVoice: inserted.hasVoice,
        hasAvatar: inserted.hasAvatar,
      });

      return inserted;
    });
  } else {
    console.log('[hubspot closedwon] resuming previous partial run', {
      customerId: customer.id,
      hubspotContactId: deal.contactId,
    });
  }

  // ─── 5. Send Welcome email (only on NEW customer) ───────────────────────
  if (isNewCustomer) {
    try {
      await triggerCustomerEmail('welcome', customer.id);
    } catch (err) {
      console.warn('[hubspot closedwon] Welcome email failed (non-blocking)', err);
    }
    // Defensive assignee-notify scan — see notify-assignee.ts comment.
    await notifyAssigneesForNewCustomer(customer.id);
    // Slack alert: NOT emitted here. Closedwon is a HubSpot deal event,
    // not a customer submission. notifyCustomerSubmitted fires from Auto 2
    // when "Complete Your Onboarding Form" completes.
  }

  // ─── 6. Update Stripe metadata — idempotent on Stripe's side ────────────
  const metadata = {
    launchpad_customer_id: customer.id,
    hubspot_contact_id: deal.contactId,
    hubspot_deal_id: deal.dealId,
  };
  try {
    await sk.customers.update(stripeCustomerId, { metadata });
    for (const { sub } of subLookups) {
      await sk.subscriptions.update(sub.id, { metadata });
    }
  } catch (err) {
    console.warn('[hubspot closedwon] Stripe metadata update failed (non-blocking)', err);
  }

  // ─── 7. Push to HubSpot: create Ticket (if not already) + update props ──
  let ticketId = customer.hubspotTicketId ?? null;
  if (!ticketId) {
    const customerName = customer.name;
    const created = await createCustomerJourneyTicket({
      // "LP" marks LaunchPad-created tickets. The pipeline (Customer Journey
      // Stages) already conveys "this is a CJ ticket"; the suffix
      // disambiguates LP-created tickets from any future manual or
      // other-integration-created tickets that may land in the same pipeline.
      subject: `${customerName} - LP`,
      stageLabel: 'Pre-Onboarding',
      contactId: deal.contactId,
      dealId: deal.dealId,
      // NOTE: no custom properties set on Ticket creation. Per the lean-property
      // audit (2026-05-13), launchpad_customer_id is NOT a Ticket property —
      // the Contact association already links the ticket back to the customer.
    });
    ticketId = created.ticketId;

    // Seed the post-launch state mirror (Phase 3). The next stage move
    // arrives via HubSpot webhook with a correct from_state in the
    // transition log instead of NULL.
    await db
      .update(schema.customers)
      .set({ hubspotTicketId: ticketId, onboardingState: 'Pre-Onboarding' })
      .where(eq(schema.customers.id, customer.id));

  }

  // Read the workflow's paymentMode so we can push it to HubSpot as a
  // Contact property. Lets HubSpot Workflows branch on payment behavior
  // (e.g. "create Activate-trial task if rejig_payment_mode = setup-intent-at-intake")
  // without enumerating brokerage names — future-proof when IPRE etc. land.
  const customerTemplates = await db.query.workflowTemplates.findMany({
    where: (t, { eq: eqOp }) => eqOp(t.workflowKey, customer.workflowKey),
    columns: { paymentMode: true },
    limit: 1,
  });
  const paymentMode = customerTemplates[0]?.paymentMode ?? 'pre-paid';

  // Update Contact custom properties (LaunchPad anchors) — idempotent.
  // NOTE: HubSpot enum properties take the INTERNAL value (lowercase snake_case),
  // NOT the display label. rejig_brokerage_channel options are configured as
  // d2c / b2b_keyes / b2b_bw / b2b_ipre.
  await updateContactProperties(deal.contactId, {
    launchpad_customer_id: customer.id,
    stripe_customer_id: stripeCustomerId,
    rejig_brokerage_channel: 'd2c',
    rejig_payment_mode: paymentMode,                                            // for HS Workflow branching
  });

  // Update Deal custom property — idempotent
  await updateDealProperties(deal.dealId, {
    launchpad_customer_id: customer.id,
  });

  return {
    customerId: customer.id,
    hubspotContactId: deal.contactId,
    hubspotDealId: deal.dealId,
    hubspotTicketId: ticketId,
    subscriptionsCreated: isNewCustomer ? subLookups.length : 0,
  };
}

function mapStripeSubStatus(status: Stripe.Subscription.Status): 'Active' | 'Trial' | 'Past Due' | 'Cancelled' {
  switch (status) {
    case 'active':
      return 'Active';
    case 'trialing':
      return 'Trial';
    case 'past_due':
      return 'Past Due';
    case 'canceled':
    case 'incomplete_expired':
      return 'Cancelled';
    default:
      return 'Active';
  }
}
