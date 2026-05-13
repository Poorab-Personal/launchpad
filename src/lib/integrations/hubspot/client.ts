import { Client } from '@hubspot/api-client';

// HubSpot's SDK has per-object-type AssociationSpec enums that all share the
// same string value "HUBSPOT_DEFINED". Casting to `any` lets one constant work
// across Ticket / Note / Contact / Deal association calls without juggling
// imports from a dozen different generated files.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HS_DEFINED = 'HUBSPOT_DEFINED' as any;

let _client: Client | null = null;

/**
 * Lazy HubSpot client init. Same pattern as src/lib/stripe.ts —
 * boot doesn't require the env var, only when actually called.
 *
 * Uses Developer Platform static auth token (from launchpad-integration project).
 * Set as HUBSPOT_STATIC_TOKEN in env.
 */
function client(): Client {
  if (_client) return _client;
  const token = process.env.HUBSPOT_STATIC_TOKEN;
  if (!token) {
    throw new Error(
      'HUBSPOT_STATIC_TOKEN is not set. Required for HubSpot API operations.',
    );
  }
  _client = new Client({ accessToken: token });
  return _client;
}

export type HubSpotDealWithContact = {
  dealId: string;
  dealName: string;
  dealStage: string;
  magicLinkEmail: string | null;
  stripePaymentId: string | null;        // Core sub_id — legacy property name
  voiceStripePaymentId: string | null;   // Voice add-on sub_id
  avatarStripePaymentId: string | null;  // Avatar add-on sub_id
  contactId: string;
  contactEmail: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactPhone: string | null;
  contactCompany: string | null;
};

/**
 * Fetch a Deal by ID with all the properties + first associated Contact
 * we need for closedwon processing. Throws if Deal not found or no Contact.
 */
export async function getDealForClosedWon(dealId: string): Promise<HubSpotDealWithContact> {
  const hs = client();

  // 1. Fetch Deal with custom properties + Contact association
  const deal = await hs.crm.deals.basicApi.getById(
    dealId,
    [
      'dealname',
      'dealstage',
      'magic_link_email',
      'stripe_payment_id',
      'voice_stripe_payment_id',
      'avatar_stripe_payment_id',
    ],
    undefined,
    ['contacts'],
  );

  const contactAssoc = deal.associations?.contacts?.results ?? [];
  if (contactAssoc.length === 0) {
    throw new Error(`Deal ${dealId} has no associated Contact`);
  }
  const contactId = String(contactAssoc[0].id);

  // 2. Fetch Contact
  const contact = await hs.crm.contacts.basicApi.getById(contactId, [
    'email',
    'firstname',
    'lastname',
    'phone',
    'company',
  ]);

  return {
    dealId,
    dealName: deal.properties.dealname ?? '',
    dealStage: deal.properties.dealstage ?? '',
    magicLinkEmail: deal.properties.magic_link_email ?? null,
    stripePaymentId: deal.properties.stripe_payment_id ?? null,
    voiceStripePaymentId: deal.properties.voice_stripe_payment_id ?? null,
    avatarStripePaymentId: deal.properties.avatar_stripe_payment_id ?? null,
    contactId,
    contactEmail: contact.properties.email ?? null,
    contactFirstName: contact.properties.firstname ?? null,
    contactLastName: contact.properties.lastname ?? null,
    contactPhone: contact.properties.phone ?? null,
    contactCompany: contact.properties.company ?? null,
  };
}

/**
 * Create a Ticket in the Customer Journey Stages pipeline and associate it
 * with the given Contact + Deal. Returns the new Ticket ID.
 *
 * The pipeline stage IDs are looked up by label — we don't hardcode the
 * numeric IDs because they're per-portal. First call caches the lookup.
 */
let _stageIdCache: Record<string, string> | null = null;

async function getStageIdByLabel(stageLabel: string): Promise<string> {
  if (_stageIdCache) {
    const id = _stageIdCache[stageLabel];
    if (!id) throw new Error(`No pipeline stage labeled "${stageLabel}"`);
    return id;
  }

  const hs = client();
  // Customer Journey Stages pipeline has hs_pipeline=0 per the audit.
  const pipeline = await hs.crm.pipelines.pipelinesApi.getById('tickets', '0');
  const cache: Record<string, string> = {};
  for (const stage of pipeline.stages) {
    cache[stage.label] = stage.id;
  }
  _stageIdCache = cache;
  const id = cache[stageLabel];
  if (!id) throw new Error(`No pipeline stage labeled "${stageLabel}" (have: ${Object.keys(cache).join(', ')})`);
  return id;
}

export async function createCustomerJourneyTicket(args: {
  subject: string;
  stageLabel: string;        // e.g. "Pre-Onboarding"
  contactId: string;
  dealId: string;
  ownerId?: string;          // HubSpot User ID (optional; from the Deal owner if known)
  customProperties?: Record<string, string | number | boolean | null>;
}): Promise<{ ticketId: string }> {
  const hs = client();
  const stageId = await getStageIdByLabel(args.stageLabel);

  const ticket = await hs.crm.tickets.basicApi.create({
    properties: {
      subject: args.subject,
      hs_pipeline: '0',           // Customer Journey Stages
      hs_pipeline_stage: stageId,
      ...(args.ownerId ? { hubspot_owner_id: args.ownerId } : {}),
      ...Object.fromEntries(
        Object.entries(args.customProperties ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)]),
      ),
    },
    associations: [
      // Ticket → Contact (association type 16)
      {
        to: { id: args.contactId },
        types: [{ associationCategory: HS_DEFINED, associationTypeId: 16 }],
      },
      // Ticket → Deal (association type 28)
      {
        to: { id: args.dealId },
        types: [{ associationCategory: HS_DEFINED, associationTypeId: 28 }],
      },
    ],
  });

  return { ticketId: ticket.id };
}

export async function updateContactProperties(
  contactId: string,
  properties: Record<string, string | number | boolean | null>,
): Promise<void> {
  const hs = client();
  await hs.crm.contacts.basicApi.update(contactId, {
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, v == null ? '' : String(v)]),
    ),
  });
}

export async function updateDealProperties(
  dealId: string,
  properties: Record<string, string | number | boolean | null>,
): Promise<void> {
  const hs = client();
  await hs.crm.deals.basicApi.update(dealId, {
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, v == null ? '' : String(v)]),
    ),
  });
}

/**
 * Post a Note on a Deal. Used for surfacing validation errors back to the
 * sales rep (e.g. "Stripe subscription not found").
 */
export async function postNoteOnDeal(dealId: string, body: string): Promise<void> {
  const hs = client();
  await hs.crm.objects.notes.basicApi.create({
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now().toString(),
    },
    associations: [
      // Note → Deal (association type 214)
      {
        to: { id: dealId },
        types: [{ associationCategory: HS_DEFINED, associationTypeId: 214 }],
      },
    ],
  });
}
