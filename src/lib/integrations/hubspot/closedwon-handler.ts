import Stripe from 'stripe';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { generateTasksFromTemplate } from '@/lib/automations/generate-tasks';
import { triggerCustomerEmail } from '@/lib/automations/trigger-email';
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
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
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

  // ─── 4. Insert Customer + Subscriptions + generate tasks ────────────────
  // D2C-Standard is the only D2C workflow today.
  const channelRow = await db.query.channels.findFirst({
    where: (channels, { eq }) => eq(channels.code, 'Standard'),
  });
  if (!channelRow) {
    throw new Error('No "Standard" channel found in DB — required for D2C closedwon');
  }

  const customerName = [deal.contactFirstName, deal.contactLastName]
    .filter(Boolean)
    .join(' ')
    .trim() || deal.dealName || deal.contactEmail || 'Unknown';

  // Read trial-vs-active status from the first sub for the customer.subscriptionStatus mirror.
  const firstSub = subLookups[0].sub;
  const subStatusMirror: 'Active' | 'Trial' = firstSub.status === 'trialing' ? 'Trial' : 'Active';

  const customer = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.customers)
      .values({
        name: customerName,
        type: 'D2C',
        channelId: channelRow.id,
        workflowKey: 'D2C-Standard',
        contactEmail: deal.magicLinkEmail!,                                       // where the magic link goes
        platformEmail: deal.contactEmail!,                                        // canonical contact email
        phone: deal.contactPhone ?? null,
        businessName: deal.contactCompany ?? null,
        currentStage: 'Getting Started',
        hubspotContactId: deal.contactId,
        hubspotDealId: deal.dealId,
        stripeCustomerId,
        // Legacy single-value mirror columns kept in sync for backwards-compat
        // during transition. customer_subscriptions is the new source of truth.
        stripeSubscriptionId: firstSub.id,
        subscriptionStatus: subStatusMirror,
        hasVoice: subLookups.some((s) => s.product === 'Voice'),
        hasAvatar: subLookups.some((s) => s.product === 'Avatar'),
      })
      .returning();

    // Insert one customer_subscriptions row per Stripe sub we found.
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

  // ─── 5. Send Welcome email (magic-link in template) ─────────────────────
  // Best-effort; doesn't block downstream pushes.
  try {
    await triggerCustomerEmail('welcome', customer.id);
  } catch (err) {
    console.warn('[hubspot closedwon] Welcome email failed (non-blocking)', err);
  }

  // ─── 6. Update Stripe metadata on customer + each subscription ──────────
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

  // ─── 7. Push to HubSpot: create Ticket + update Contact + Deal ──────────
  const { ticketId } = await createCustomerJourneyTicket({
    subject: `${customerName} - CJ`,
    stageLabel: 'Pre-Onboarding',
    contactId: deal.contactId,
    dealId: deal.dealId,
    customProperties: {
      launchpad_customer_id: customer.id,
    },
  });

  // Store the ticket ID on the customer row
  await db
    .update(schema.customers)
    .set({ hubspotTicketId: ticketId })
    .where((await import('drizzle-orm')).eq(schema.customers.id, customer.id));

  // Update Contact custom properties (LaunchPad anchors)
  await updateContactProperties(deal.contactId, {
    launchpad_customer_id: customer.id,
    stripe_customer_id: stripeCustomerId,
    rejig_brokerage_channel: 'D2C',
  });

  // Update Deal custom property
  await updateDealProperties(deal.dealId, {
    launchpad_customer_id: customer.id,
  });

  return {
    customerId: customer.id,
    hubspotContactId: deal.contactId,
    hubspotDealId: deal.dealId,
    hubspotTicketId: ticketId,
    subscriptionsCreated: subLookups.length,
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
