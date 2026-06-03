/**
 * POST /api/agent-lookup — brokerage landing-page verification + signup.
 *
 * Thin dispatcher (per CLAUDE.md): parse input, gate on hCaptcha, resolve the
 * brokerage + match the cached roster, then hand the atomic create to
 * `createRosterCustomer`. No business logic inline beyond input shaping.
 *
 * Flow (docs/integrations/dmg-roster-plan.md §4.2):
 *   1. verify hCaptcha → 400 if invalid
 *   2. resolve brokerage by slug (active + verification_mode='soft')
 *   3. lookupByEmail (cache-only — no DMG call)
 *   4. no match → 200 { match: false, support }
 *   5. match → atomic createCustomer (reused helper) → set
 *      brokerage_roster.customer_id → fire-and-forget asset import →
 *      200 { match: true, redirect: '/r/<accessToken>' }
 */
import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { verifyHCaptcha } from '@/lib/captcha';
import { getSetting } from '@/lib/db';
import { lookupByEmail } from '@/lib/roster/lookup';
import { createRosterCustomer } from '@/lib/automations/create-roster-customer';
import { notifyAssigneesForNewCustomer } from '@/lib/automations/notify-assignee';
import { importRosterCustomerAssets } from '@/lib/roster/import-assets';

interface SourceOffice {
  Address1?: string | null;
  Address2?: string | null;
  Address3?: string | null;
  City?: string | null;
  State?: string | null;
}
interface SourceRegion {
  RegionName?: string | null;
}
interface RosterSourceData {
  office?: SourceOffice | null;
  user?: { Regions?: SourceRegion[] | null } | null;
}

/** Minimal HTML → plain text. No existing util in the repo; DMG Bio is light
 *  HTML (<p>, <br>, <strong>). Strip tags, decode a few common entities,
 *  collapse whitespace. The agent confirms/edits on the intake form anyway. */
function stripHtml(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

/** Join office address parts: "Address1 Address2 Address3, City, State". */
function formatOfficeAddress(office: SourceOffice | null | undefined): string | null {
  if (!office) return null;
  const street = [office.Address1, office.Address2, office.Address3]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s && s.length))
    .join(' ');
  const parts = [street, office.City?.trim(), office.State?.trim()].filter(
    (s): s is string => Boolean(s && s.length),
  );
  const joined = parts.join(', ');
  return joined.length > 0 ? joined : null;
}

/** Region names joined, dropping internal regions (e.g. "Keyes Employees"). */
function formatServiceAreas(regions: SourceRegion[] | null | undefined): string | null {
  if (!regions || regions.length === 0) return null;
  const names = regions
    .map((r) => r?.RegionName?.trim())
    .filter((n): n is string => Boolean(n && n.length))
    .filter((n) => !/employees/i.test(n));
  const joined = names.join(', ');
  return joined.length > 0 ? joined : null;
}

/** Derive the channel code from a brokerage default workflow key.
 *  Workflow key format is `{type}-{code}` (e.g. 'B2B-IPRE' → 'IPRE'). */
function channelCodeForWorkflow(workflowKey: string): string {
  const idx = workflowKey.indexOf('-');
  return idx >= 0 ? workflowKey.slice(idx + 1) : workflowKey;
}

export async function POST(request: NextRequest) {
  let body: {
    email?: unknown;
    slug?: unknown;
    hcaptchaToken?: unknown;
    // Test-mode-only fields (see handleTestMode). Ignored on the prod path.
    testMode?: unknown;
    agentEmail?: unknown;
    receiveEmail?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Test-mode branch — purely additive. Dispatch BEFORE any prod field parsing
  // so the real path below stays byte-for-byte behaviorally identical.
  if (body.testMode === true) {
    return handleTestMode(request, body);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const hcaptchaToken =
    typeof body.hcaptchaToken === 'string' ? body.hcaptchaToken : '';

  if (!email || !slug) {
    return Response.json(
      { error: 'Missing required fields: email, slug' },
      { status: 400 },
    );
  }

  // 1. hCaptcha gate. verifyHCaptcha fails closed on any error.
  const remoteip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
  const captchaOk = await verifyHCaptcha(hcaptchaToken, remoteip);
  if (!captchaOk) {
    return Response.json(
      { error: 'Captcha verification failed. Please try again.' },
      { status: 400 },
    );
  }

  // 2. Resolve brokerage by slug (raw row — the mapped Brokerage type omits
  //    master_logo_url / support_contact_* / verification_mode). Active only.
  const brokerage = await db.query.brokerages.findFirst({
    where: and(
      eq(schema.brokerages.landingPageSlug, slug),
      eq(schema.brokerages.active, true),
    ),
  });
  if (!brokerage) {
    return Response.json({ error: 'Unknown brokerage' }, { status: 404 });
  }
  // Escape hatch: soft auth only. magic_link_required is a future branch.
  if (brokerage.verificationMode !== 'soft') {
    return Response.json(
      { error: 'This brokerage requires a different verification method.' },
      { status: 409 },
    );
  }

  const support = {
    name: brokerage.supportContactName ?? null,
    email: brokerage.supportContactEmail ?? null,
    phone: brokerage.supportContactPhone ?? null,
  };

  // 3. Cache-only roster match.
  const hit = await lookupByEmail(brokerage.id, email);

  // 4. No match → generic, non-enumerating copy + support contact.
  if (!hit) {
    console.warn(
      `[agent-lookup] miss brokerage=${brokerage.landingPageSlug} emailHash=${hashEmail(email)}`,
    );
    return Response.json({ match: false, support });
  }

  // 5. Match. Idempotency: if this roster row already minted a customer,
  //    redirect to that existing portal instead of creating a duplicate.
  const rosterRow = hit.row;
  if (rosterRow.customerId) {
    const existing = await db.query.customers.findFirst({
      where: eq(schema.customers.id, rosterRow.customerId),
      columns: { accessToken: true },
    });
    if (existing) {
      return Response.json({
        match: true,
        redirect: `/r/${existing.accessToken}`,
      });
    }
  }

  // Canonical roster email (not the typed casing) → contact + platform email.
  const matchedEmail =
    hit.matchedEmail === 'public'
      ? (rosterRow.publicEmail ?? email)
      : (rosterRow.privateEmail ?? email);
  const otherEmail =
    hit.matchedEmail === 'public' ? rosterRow.privateEmail : rosterRow.publicEmail;

  const sourceData = (rosterRow.sourceData ?? {}) as RosterSourceData;
  const channelCode = channelCodeForWorkflow(brokerage.defaultWorkflowKey);

  const result = await createRosterCustomer({
    brokerageRosterId: rosterRow.id,
    brokerageId: brokerage.id,
    channelCode,
    matchedEmail,
    name: rosterRow.displayName ?? matchedEmail,
    businessName: rosterRow.displayName ?? null,
    phone: rosterRow.cellPhone ?? null,
    website: rosterRow.website ?? null,
    bio: stripHtml(rosterRow.bio),
    licenseNumber: rosterRow.license ?? null,
    mlsIds: rosterRow.mlsIds ?? null,
    businessAddress: formatOfficeAddress(sourceData.office),
    serviceAreas: formatServiceAreas(sourceData.user?.Regions),
    otherEmails: otherEmail ?? null,
  });

  // Await the photo + logo download → Blob BEFORE returning the redirect.
  // Was previously fire-and-forget for speed, but that created a race: the
  // form on /r/[token] captured an empty file state at first render and
  // never re-hydrated when the async import completed. The 2026-06-02 fix
  // pays a 2-5s verification cost to guarantee assets are persisted before
  // the agent ever sees the form. `importRosterCustomerAssets` never throws.
  await importRosterCustomerAssets({
    customerId: result.id,
    photoUrl: rosterRow.photoUrl ?? null,
    masterLogoUrl: brokerage.masterLogoUrl ?? null,
  });

  // Defensive assignee-notify scan — see notify-assignee.ts comment.
  await notifyAssigneesForNewCustomer(result.id);

  return Response.json({ match: true, redirect: `/r/${result.accessToken}` });
}

/**
 * Test-mode handler for /[slug]/test — additive sibling of the prod POST path.
 *
 * Loads a REAL agent's roster pre-pop data (agentEmail) but creates the
 * customer with the tester's own inbox (receiveEmail) as contact + platform
 * email, marks it `LP TEST — {name}` + `environment: ['test']`, and returns
 * the same `{ match, redirect }` contract the prod path uses.
 *
 * Differences from prod: the server-side `b2b_test_route_enabled='on'` gate,
 * the email swap, the LP TEST marking, and the re-entry recovery (find an
 * existing test customer whose contact_email = receiveEmail). hCaptcha is the
 * SAME real gate. Everything downstream (lookup, atomic create, asset import)
 * reuses the prod helpers.
 */
async function handleTestMode(
  request: NextRequest,
  body: {
    slug?: unknown;
    hcaptchaToken?: unknown;
    agentEmail?: unknown;
    receiveEmail?: unknown;
  },
): Promise<Response> {
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const agentEmail =
    typeof body.agentEmail === 'string' ? body.agentEmail.trim() : '';
  const receiveEmail =
    typeof body.receiveEmail === 'string' ? body.receiveEmail.trim() : '';
  const hcaptchaToken =
    typeof body.hcaptchaToken === 'string' ? body.hcaptchaToken : '';

  if (!slug || !agentEmail || !receiveEmail) {
    return Response.json(
      { error: 'Missing required fields: slug, agentEmail, receiveEmail' },
      { status: 400 },
    );
  }

  // Server-side route gate — never trust the client's testMode flag alone.
  const testEnabled = (await getSetting('b2b_test_route_enabled')) === 'on';
  if (!testEnabled) {
    return Response.json({ error: 'Test mode is not enabled.' }, { status: 403 });
  }

  // hCaptcha gate (same real verify as prod). Fails closed on any error.
  const remoteip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
  const captchaOk = await verifyHCaptcha(hcaptchaToken, remoteip);
  if (!captchaOk) {
    return Response.json(
      { error: 'Captcha verification failed. Please try again.' },
      { status: 400 },
    );
  }

  // Resolve brokerage by slug (active + soft auth), same as prod.
  const brokerage = await db.query.brokerages.findFirst({
    where: and(
      eq(schema.brokerages.landingPageSlug, slug),
      eq(schema.brokerages.active, true),
    ),
  });
  if (!brokerage) {
    return Response.json({ error: 'Unknown brokerage' }, { status: 404 });
  }
  if (brokerage.verificationMode !== 'soft') {
    return Response.json(
      { error: 'This brokerage requires a different verification method.' },
      { status: 409 },
    );
  }

  const support = {
    name: brokerage.supportContactName ?? null,
    email: brokerage.supportContactEmail ?? null,
    phone: brokerage.supportContactPhone ?? null,
  };

  // Cache-only roster match on the AGENT email (the data source).
  const hit = await lookupByEmail(brokerage.id, agentEmail);
  if (!hit) {
    console.warn(
      `[agent-lookup:test] miss brokerage=${brokerage.landingPageSlug} emailHash=${hashEmail(agentEmail)}`,
    );
    return Response.json({ match: false, support });
  }

  const rosterRow = hit.row;
  const sourceData = (rosterRow.sourceData ?? {}) as RosterSourceData;
  const channelCode = channelCodeForWorkflow(brokerage.defaultWorkflowKey);
  const realName = rosterRow.displayName ?? agentEmail;
  const targetName = `LP TEST — ${realName}`;

  // Recovery / re-entry: per-(receiveEmail, agent). Picking a DIFFERENT agent
  // with the same receive email now creates a new test customer instead of
  // resuming the prior one. Match is on the deterministic test-customer name
  // (LP TEST — {displayName}) which is constructed identically below.
  const existingTest = await db.query.customers.findFirst({
    where: and(
      eq(schema.customers.contactEmail, receiveEmail),
      eq(schema.customers.name, targetName),
      sql`${schema.customers.environment} @> '{test}'`,
    ),
    columns: { accessToken: true },
  });
  if (existingTest) {
    return Response.json({
      match: true,
      redirect: `/r/${existingTest.accessToken}`,
    });
  }

  // Create the test customer: real roster data, BUT the tester's receive email
  // as contact + platform email, an LP TEST name prefix, and environment=test.
  const result = await createRosterCustomer({
    brokerageRosterId: rosterRow.id,
    brokerageId: brokerage.id,
    channelCode,
    matchedEmail: receiveEmail, // → contact_email + platform_email (tester's inbox)
    name: `LP TEST — ${realName}`,
    businessName: rosterRow.displayName ?? null,
    phone: rosterRow.cellPhone ?? null,
    website: rosterRow.website ?? null,
    bio: stripHtml(rosterRow.bio),
    licenseNumber: rosterRow.license ?? null,
    mlsIds: rosterRow.mlsIds ?? null,
    businessAddress: formatOfficeAddress(sourceData.office),
    serviceAreas: formatServiceAreas(sourceData.user?.Regions),
    otherEmails: null,
    environment: ['test'],
  });

  // Same synchronous asset import as prod — assets persisted before redirect.
  await importRosterCustomerAssets({
    customerId: result.id,
    photoUrl: rosterRow.photoUrl ?? null,
    masterLogoUrl: brokerage.masterLogoUrl ?? null,
  });

  // Defensive assignee-notify scan — see notify-assignee.ts comment.
  await notifyAssigneesForNewCustomer(result.id);

  return Response.json({ match: true, redirect: `/r/${result.accessToken}` });
}

/** Coarse, non-reversible-ish hash for log lines — never log raw emails. */
function hashEmail(email: string): string {
  let h = 0;
  const s = email.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `e${(h >>> 0).toString(16)}`;
}
