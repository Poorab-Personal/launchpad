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

async function ensureStageCache(): Promise<Record<string, string>> {
  if (_stageIdCache) return _stageIdCache;
  const hs = client();
  // Customer Journey Stages pipeline has hs_pipeline=0 per the audit.
  const pipeline = await hs.crm.pipelines.pipelinesApi.getById('tickets', '0');
  const cache: Record<string, string> = {};
  for (const stage of pipeline.stages) {
    cache[stage.label] = stage.id;
  }
  _stageIdCache = cache;
  return cache;
}

// LP onboarding_state → HS CJ pipeline stage label translation.
// Mostly identity, except 'At-Risk' (LP enum) → 'At Risk' (HS label) and
// any other future mismatches go here. Centralizing prevents the same
// silent push failure that surfaced when At-Risk transitions weren't
// reflecting in HS (2026-05-16 smoke).
const LP_TO_HS_STAGE_LABEL: Record<string, string> = {
  'At-Risk': 'At Risk',
};

async function getStageIdByLabel(stageLabel: string): Promise<string> {
  const cache = await ensureStageCache();
  const hsLabel = LP_TO_HS_STAGE_LABEL[stageLabel] ?? stageLabel;
  const id = cache[hsLabel];
  if (!id) throw new Error(`No pipeline stage labeled "${hsLabel}" (have: ${Object.keys(cache).join(', ')})`);
  return id;
}

/**
 * Reverse lookup: stage ID → label. Used by the ticket-stage webhook
 * handler since HubSpot delivers stage *IDs* in property change payloads,
 * not labels.
 */
export async function getStageLabelById(stageId: string): Promise<string | null> {
  const cache = await ensureStageCache();
  const entry = Object.entries(cache).find(([, id]) => id === stageId);
  return entry ? entry[0] : null;
}

/**
 * Create a Ticket in the Customer Journey pipeline.
 *
 * Always associates to the Contact. Optionally associates to a Deal (D2C
 * closedwon flow) and/or a Company (B2B agent-intake flow).
 *
 *   D2C closedwon path:  contactId + dealId (associated to the closedwon Deal)
 *   B2B intake path:     contactId + companyId (associated to the brokerage)
 *
 * The two paths intentionally don't cross — B2B doesn't get a Deal
 * association (the brokerage's master enterprise Deal stays clean), and
 * D2C doesn't get a Company association (D2C agents aren't tied to a
 * brokerage Company).
 */
export async function createCustomerJourneyTicket(args: {
  subject: string;
  stageLabel: string;        // e.g. "Pre-Onboarding"
  contactId: string;
  dealId?: string;
  companyId?: string;
  ownerId?: string;          // HubSpot User ID (optional)
  customProperties?: Record<string, string | number | boolean | null>;
}): Promise<{ ticketId: string }> {
  const hs = client();
  const stageId = await getStageIdByLabel(args.stageLabel);

  const associations = [
    // Ticket → Contact (association type 16)
    {
      to: { id: args.contactId },
      types: [{ associationCategory: HS_DEFINED, associationTypeId: 16 }],
    },
  ];
  if (args.dealId) {
    // Ticket → Deal (association type 28)
    associations.push({
      to: { id: args.dealId },
      types: [{ associationCategory: HS_DEFINED, associationTypeId: 28 }],
    });
  }
  if (args.companyId) {
    // Ticket → Company (association type 339, "primary" company)
    associations.push({
      to: { id: args.companyId },
      types: [{ associationCategory: HS_DEFINED, associationTypeId: 339 }],
    });
  }

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
    associations,
  });

  return { ticketId: ticket.id };
}

/**
 * Search HubSpot for a Contact by email (case-insensitive). Returns the
 * Contact ID if found, or null. Used by the B2B intake flow to avoid
 * duplicating Contacts when an agent already exists (e.g. a prior D2C
 * lead, an imported roster row).
 */
export async function findContactByEmail(email: string): Promise<string | null> {
  const hs = client();
  const result = await hs.crm.contacts.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          { propertyName: 'email', operator: 'EQ' as never, value: email.trim().toLowerCase() },
        ],
      },
    ],
    properties: ['email'],
    limit: 1,
    sorts: [],
    after: undefined as unknown as string,
  });
  return result.results.length > 0 ? result.results[0].id : null;
}

/**
 * Create a HubSpot Contact, optionally associating to a Company at create
 * time. Used by the B2B intake flow.
 *
 * If a Contact with this email already exists, the create call will fail
 * with a 409. Callers should use findContactByEmail first.
 */
export async function createContact(args: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  companyId?: string;          // associate Contact → Company at create
  customProperties?: Record<string, string | number | boolean | null>;
}): Promise<{ contactId: string }> {
  const hs = client();

  const properties: Record<string, string> = {
    email: args.email.trim(),
  };
  if (args.firstName) properties.firstname = args.firstName;
  if (args.lastName) properties.lastname = args.lastName;
  if (args.phone) properties.phone = args.phone;
  for (const [k, v] of Object.entries(args.customProperties ?? {})) {
    properties[k] = v == null ? '' : String(v);
  }

  const associations = args.companyId
    ? [
        // Contact → Company (association type 1 — primary)
        {
          to: { id: args.companyId },
          types: [{ associationCategory: HS_DEFINED, associationTypeId: 1 }],
        },
      ]
    : undefined;

  const created = await hs.crm.contacts.basicApi.create({
    properties,
    associations,
  });

  return { contactId: created.id };
}

/**
 * Ensure a Contact is associated to a Company. Used by the B2B intake
 * flow when an existing Contact is found (via findContactByEmail) — they
 * might already have the association, or might not. HubSpot's association
 * create is idempotent on the same pair, so we just fire-and-forget.
 */
export async function ensureContactCompanyAssociation(
  contactId: string,
  companyId: string,
): Promise<void> {
  const hs = client();
  try {
    await hs.crm.associations.v4.basicApi.create(
      'contacts',
      contactId,
      'companies',
      companyId,
      [{ associationCategory: HS_DEFINED, associationTypeId: 1 }],
    );
  } catch (err) {
    // Idempotent: 409 = already associated. Don't blow up.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('409')) {
      throw err;
    }
  }
}

/**
 * Associate a HubSpot Meeting to a Ticket so CSMs see the meeting on the
 * ticket card in HS. HubSpot's HS Meetings booking flow auto-associates
 * meetings to Contacts only; the workflow that moves the ticket stage
 * can't create this association (it's enrolled on Contact, "from" is
 * locked). So our webhook handler does it via API after capturing the
 * meeting datetime.
 *
 * Idempotent: 409 = already associated → swallow. Other errors bubble.
 * Uses Meeting → Ticket type id 222 (HS-defined).
 */
export async function ensureMeetingTicketAssociation(
  meetingId: string,
  ticketId: string,
): Promise<void> {
  const hs = client();
  try {
    await hs.crm.associations.v4.basicApi.create(
      'meetings',
      meetingId,
      'tickets',
      ticketId,
      [{ associationCategory: HS_DEFINED, associationTypeId: 222 }],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists') && !msg.includes('409')) {
      throw err;
    }
  }
}

/**
 * Move an existing Customer Journey ticket to a new pipeline stage.
 * Used by Auto 2's "Launched" terminal branch to hand off post-launch
 * state management to HubSpot (LaunchPad pushes the ticket from
 * "Pre-Onboarding" → "Onboarding Scheduled" when the customer has
 * credentials + signed in; HubSpot Workflow F handles subsequent
 * transitions based on Meeting outcomes).
 */
export async function pushTicketStage(ticketId: string, stageLabel: string): Promise<void> {
  const hs = client();
  const stageId = await getStageIdByLabel(stageLabel);
  await hs.crm.tickets.basicApi.update(ticketId, {
    properties: { hs_pipeline_stage: stageId },
  });
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
 * Update custom + standard properties on a HubSpot Ticket. Parallels
 * updateContactProperties. Used by the Phase 4 BI cron to write
 * rejig_attention_reason, rejig_attention_set_at, and the recommended-
 * action property cluster onto the Customer Journey ticket.
 *
 * HubSpot rejects empty-string values for datetime / enum properties
 * with strict validation. Pass null to clear a property; the helper
 * converts null → empty string per HubSpot API convention.
 */
export async function updateTicketProperties(
  ticketId: string,
  properties: Record<string, string | number | boolean | null>,
): Promise<void> {
  const hs = client();
  await hs.crm.tickets.basicApi.update(ticketId, {
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, v == null ? '' : String(v)]),
    ),
  });
}

/**
 * Fetch the onboarding meeting booking that triggered a ticket's stage move
 * to "Onboarding Scheduled". Used by the inbound webhook to capture the
 * meeting datetime into LP (customer.callDate + calls row) so designers +
 * Account Creators can prioritize work by call-date.
 *
 * Two strategies, in order:
 *   1. Direct ticket→meeting association (the RIGHT way).
 *      Requires the HS Workflow "CSM Meeting Onboarding Created via
 *      LaunchPad" to include an "Associate meeting to ticket" action when
 *      moving the ticket to Onboarding Scheduled. If that's wired, this
 *      strategy returns the exact meeting that caused the stage change.
 *   2. Fallback via ticket→contact→meetings filtered by recency.
 *      Works WITHOUT the HS Workflow association action: follow the
 *      ticket's primary Contact, list that contact's meetings, pick the one
 *      created within 5 minutes of "now" with a future start time. Brittle
 *      when the contact already has many meetings (e.g. a Calendly-era
 *      contact who's been booked dozens of times), so the strategy-1 fix
 *      should be wired ASAP — this fallback only buys us "works today".
 */
export async function getOnboardingMeetingForTicket(
  ticketId: string,
): Promise<{ meetingId: string; startTime: string; title: string | null } | null> {
  const hs = client();

  // Always need ticket → contact for fallback path, ticket → meetings for
  // strategy-1. One request covers both.
  const ticket = await hs.crm.tickets.basicApi.getById(
    ticketId,
    ['createdate'],
    undefined,
    ['contacts', 'meetings'],
  );

  // ── Strategy 1: ticket → meeting (the right architecture) ──────────────
  const ticketMeetingIds = ticket.associations?.meetings?.results?.map((r) => r.id) ?? [];
  if (ticketMeetingIds.length > 0) {
    const ticketMeetings = await Promise.all(
      ticketMeetingIds.map((id) =>
        hs.crm.objects.basicApi.getById('meetings', id, [
          'hs_meeting_start_time',
          'hs_meeting_title',
        ]),
      ),
    );
    const pick = pickLatestFuture(ticketMeetings);
    if (pick) return pick;
  }

  // ── Strategy 2: ticket → contact → meetings (fallback) ─────────────────
  // The /test contact (poorab@rejig.ai) accumulates dozens of historical
  // meetings, and HS doesn't return contact→meeting associations in any
  // guaranteed order. So we MUST inspect every meeting and filter strictly
  // by recency relative to the ticket's createdate. Falling back to
  // "latest future on this contact" picks the wrong meeting (we hit this
  // 2026-06-02 with Amanda Pike — picked an unrelated May 30 meeting).
  const contactIds = ticket.associations?.contacts?.results?.map((r) => r.id) ?? [];
  if (contactIds.length === 0) return null;
  const contactId = contactIds[0];

  const contact = await hs.crm.contacts.basicApi.getById(
    contactId,
    undefined,
    undefined,
    ['meetings'],
  );
  const meetingIds = contact.associations?.meetings?.results?.map((r) => r.id) ?? [];
  if (meetingIds.length === 0) return null;

  // Fetch ALL meetings on this contact — no slice, because HS doesn't
  // guarantee chronological order in the associations list. Cap at 100
  // as a safety bound; real prod contacts have 0-2 meetings, /test contacts
  // 20+ historical, never approaching 100.
  const allIds = meetingIds.slice(0, 100);
  const contactMeetings = await Promise.all(
    allIds.map((id) =>
      hs.crm.objects.basicApi.getById('meetings', id, [
        'hs_meeting_start_time',
        'hs_meeting_title',
        'hs_createdate',
      ]),
    ),
  );

  // Strict recency filter: meeting created within ±10 minutes of the ticket
  // existing, AND future start time. The ±10min window catches both
  // ticket-before-meeting (typical: customer captures payment, ticket
  // created, then schedules call within minutes) and edge cases where the
  // booking flow might race. No "latest future overall" fallback — that
  // picks stale meetings off shared contacts. Better to return null and
  // let the webhook log "no associated meeting found" than to lie.
  const ticketCreatedMs = ticket.properties.createdate
    ? Date.parse(ticket.properties.createdate)
    : 0;
  const now = Date.now();
  const TEN_MIN_MS = 10 * 60_000;
  const candidates = contactMeetings.filter((m) => {
    const created = m.properties.hs_createdate ? Date.parse(m.properties.hs_createdate) : 0;
    const start = m.properties.hs_meeting_start_time
      ? Date.parse(m.properties.hs_meeting_start_time)
      : 0;
    return (
      Math.abs(created - ticketCreatedMs) <= TEN_MIN_MS &&
      start > now
    );
  });
  if (candidates.length === 0) return null;

  // Among candidates (typically exactly one), pick the most-recently-created.
  return pickLatestByCreated(candidates);
}

function pickLatestByCreated(
  meetings: Array<{ id: string; properties: Record<string, string | null | undefined> }>,
): { meetingId: string; startTime: string; title: string | null } | null {
  const scored = meetings.map((m) => ({
    id: m.id,
    start: m.properties.hs_meeting_start_time
      ? Date.parse(m.properties.hs_meeting_start_time)
      : 0,
    created: m.properties.hs_createdate ? Date.parse(m.properties.hs_createdate) : 0,
    title: m.properties.hs_meeting_title ?? null,
  }));
  const pick = scored.sort((a, b) => b.created - a.created)[0];
  if (!pick || !pick.start) return null;
  return {
    meetingId: pick.id,
    startTime: new Date(pick.start).toISOString(),
    title: pick.title,
  };
}

function pickLatestFuture(
  meetings: Array<{ id: string; properties: Record<string, string | null | undefined> }>,
): { meetingId: string; startTime: string; title: string | null } | null {
  const now = Date.now();
  type Scored = { id: string; start: number; title: string | null };
  const scored: Scored[] = meetings.map((m) => ({
    id: m.id,
    start: m.properties.hs_meeting_start_time
      ? Date.parse(m.properties.hs_meeting_start_time)
      : 0,
    title: m.properties.hs_meeting_title ?? null,
  }));
  const future = scored.filter((m) => m.start > now);
  const pick = (future.length > 0 ? future : scored).sort((a, b) => b.start - a.start)[0];
  if (!pick || !pick.start) return null;
  return {
    meetingId: pick.id,
    startTime: new Date(pick.start).toISOString(),
    title: pick.title,
  };
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
