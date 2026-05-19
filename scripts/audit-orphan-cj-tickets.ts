/**
 * Audit the 77 HS tickets in legacy Customer Journey stages.
 *
 * For each ticket: pull associated Contact (email, name, company) + try to
 * match it back to an LP customer via multiple strategies. Output CSV for
 * manual review before bulk-moving anything in HS.
 *
 * Strategies (priority order):
 *   1. EMAIL_EXACT       — HS contact email == LP.contact_email OR .platform_email
 *   2. NAME_FUZZY        — HS contact firstname+lastname appears in LP.name
 *   3. COMPANY_FUZZY     — HS contact company appears in LP.business_name
 *   4. SUBJECT_NAME      — ticket subject "Foo Bar - CJ" → both tokens appear
 *                          in LP.name OR LP.business_name (catches when LP has
 *                          a business name and HS contact has personal name)
 *   5. SUBJECT_HS_SEARCH — when ticket has NO contact association, parse
 *                          subject's name → HS Contact search → if exactly
 *                          one match, use its email/name → re-run strategies
 *                          1-2 against LP
 *   6. CONTACT_GRAPH     — graph traversal: orphan ticket → its contact →
 *                          contact's OTHER tickets → any of those tickets in
 *                          customer.hubspotTicketId means the contact "belongs
 *                          to" that LP customer. Catches B2B/team-style cases
 *                          where LP customer name is a business (Team Environs)
 *                          but the orphan ticket subject uses the contact
 *                          person's name (Dawn Landau).
 *
 * Strategy 5 covers the case where HS Contact exists but isn't formally
 * associated with the ticket. The user confirmed (Hersh Shah, Brian Bazinet)
 * that these contacts exist; the association just wasn't wired.
 *
 * Also flags whether the email is in the Rejig snapshot CSV (so user can
 * separate "churned, not in current Rejig API response" vs "completely
 * outside Rejig universe").
 *
 *   npx tsx --env-file=.env.local scripts/audit-orphan-cj-tickets.ts
 *
 * Output: scripts/data/orphan-cj-audit-{YYYY-MM-DD}.csv
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { inArray, or, ilike } from 'drizzle-orm';
import * as fs from 'fs';

const LEGACY_STAGE_IDS = [
  '1165504776', // Onboarded - Partially
  '1154519675', // Onboarding Completed
  '1165493807', // Check-in 1 Outreach
  '1154519676', // Check-in 1 Scheduled
  '1154519677', // Check-in 1 Completed
  '1165495944', // Check-in 2 Outreach
  '1154519678', // Check-in 2 Scheduled
  '1154519679', // Check-in 2 Completed
  '1162370855', // Pre-renewal Outreach
  '1154519680', // Pre-renewal Scheduled
  '1154519681', // Pre-renewal Completed
];
const STAGE_LABEL: Record<string, string> = {
  '1165504776': 'Onboarded - Partially',
  '1154519675': 'Onboarding Completed',
  '1165493807': 'Check-in 1 Outreach',
  '1154519676': 'Check-in 1 Scheduled',
  '1154519677': 'Check-in 1 Completed',
  '1165495944': 'Check-in 2 Outreach',
  '1154519678': 'Check-in 2 Scheduled',
  '1154519679': 'Check-in 2 Completed',
  '1162370855': 'Pre-renewal Outreach',
  '1154519680': 'Pre-renewal Scheduled',
  '1154519681': 'Pre-renewal Completed',
};

type Ticket = {
  id: string;
  stage: string;
  subject: string;
  createDate: string;
  lastModified: string;
  contactIds: string[];
};

type Contact = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string;
};

async function fetchOrphanTickets(hs: Client): Promise<Ticket[]> {
  const tickets: Ticket[] = [];
  let after: string | undefined;
  let page = 0;
  do {
    const r = await hs.crm.tickets.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: '0' } as any,
          { propertyName: 'hs_pipeline_stage', operator: 'IN', values: LEGACY_STAGE_IDS } as any,
        ],
      }],
      properties: ['hs_pipeline_stage', 'subject', 'createdate', 'hs_lastmodifieddate'],
      sorts: ['hs_object_id'],
      limit: 100,
      after,
    });
    for (const t of r.results) {
      tickets.push({
        id: t.id,
        stage: t.properties.hs_pipeline_stage as string,
        subject: (t.properties.subject as string) ?? '',
        createDate: (t.properties.createdate as string) ?? '',
        lastModified: (t.properties.hs_lastmodifieddate as string) ?? '',
        contactIds: [],
      });
    }
    after = r.paging?.next?.after;
    page++;
    await new Promise((r) => setTimeout(r, 700));
  } while (after && page < 10);
  return tickets;
}

async function fetchAssociations(hs: Client, tickets: Ticket[]) {
  for (const t of tickets) {
    try {
      const a = await hs.crm.associations.v4.basicApi.getPage('tickets', t.id, 'contacts');
      t.contactIds = a.results.map((r) => String(r.toObjectId));
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function fetchContacts(hs: Client, ids: string[]): Promise<Map<string, Contact>> {
  const map = new Map<string, Contact>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const r = await hs.crm.contacts.batchApi.read({
        inputs: batch.map((id) => ({ id })),
        properties: ['email', 'firstname', 'lastname', 'company'],
      } as any);
      for (const c of r.results) {
        const p = c.properties as any;
        map.set(c.id, {
          id: c.id,
          email: (p.email || '').toLowerCase(),
          firstName: p.firstname || '',
          lastName: p.lastname || '',
          company: p.company || '',
        });
      }
    } catch (e) {
      console.error('contact batch err', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return map;
}

/**
 * Parse the ticket subject into a "display name" suitable for fuzzy matching.
 *
 * Subject patterns observed:
 *   "Hersh Shah - CJ"
 *   "John Saddi — CJ"
 *   "DeChambeau Team-CJ"
 *   "Highland Park Office-CJ"
 *   "Rob Kittle (2 year + avatar) — CJ"
 *
 * Strategy: drop the trailing "- CJ" / "— CJ" / "-CJ" / "- CSM" suffix,
 * then drop any parenthetical, then return the cleaned core.
 */
function parseSubject(subject: string): string {
  let s = subject.trim();
  // Strip suffix variants
  s = s.replace(/\s*[—–-]\s*(CJ|CSM)\s*$/i, '').trim();
  s = s.replace(/[—–-]\s*CJ\s*$/i, '').trim();
  // Drop parenthetical
  s = s.replace(/\s*\([^)]+\)\s*/g, '').trim();
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ');
  return s;
}

async function fetchContactTickets(hs: Client, contactId: string): Promise<string[]> {
  try {
    const a = await hs.crm.associations.v4.basicApi.getPage('contacts', contactId, 'tickets');
    return a.results.map((r) => String(r.toObjectId));
  } catch {
    return [];
  }
}

async function searchHsContactsByName(hs: Client, name: string): Promise<Contact[]> {
  // HS Contact search by `query` does full-text — works on name, email, etc.
  // We use this for tickets where no formal Contact association exists.
  try {
    const r = await hs.crm.contacts.searchApi.doSearch({
      query: name,
      properties: ['email', 'firstname', 'lastname', 'company'],
      limit: 10,
    } as any);
    return r.results.map((c) => {
      const p = c.properties as any;
      return {
        id: c.id,
        email: (p.email || '').toLowerCase(),
        firstName: p.firstname || '',
        lastName: p.lastname || '',
        company: p.company || '',
      };
    });
  } catch {
    return [];
  }
}

function csvEscape(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });

  console.log('[audit] Fetching legacy-stage tickets…');
  const tickets = await fetchOrphanTickets(hs);
  console.log(`[audit]   ${tickets.length} tickets`);

  console.log('[audit] Fetching associations…');
  await fetchAssociations(hs, tickets);

  const allContactIds = [...new Set(tickets.flatMap((t) => t.contactIds))];
  console.log(`[audit]   ${allContactIds.length} unique contacts`);

  console.log('[audit] Fetching contact properties…');
  const contactsMap = await fetchContacts(hs, allContactIds);

  // Get ALL LP customers for fuzzy matching
  console.log('[audit] Loading LP customers…');
  const allLp = await db.query.customers.findMany();
  console.log(`[audit]   ${allLp.length} LP customers`);

  // Build lookup indexes
  const lpByEmail = new Map<string, typeof allLp[0]>();
  for (const c of allLp) {
    if (c.contactEmail) lpByEmail.set(c.contactEmail.toLowerCase(), c);
    if (c.platformEmail) lpByEmail.set(c.platformEmail.toLowerCase(), c);
  }
  // For name/company fuzzy match, prepare lowercase strings on each LP row
  const lpFuzzy = allLp.map((c) => ({
    row: c,
    name: (c.name || '').toLowerCase(),
    business: (c.businessName || '').toLowerCase(),
    email: (c.contactEmail || '').toLowerCase(),
  }));

  // Strategy 6 lookup: HS ticket ID → LP customer (only for LP-managed tickets)
  const lpByTicketId = new Map<string, typeof allLp[0]>();
  for (const c of allLp) {
    if (c.hubspotTicketId) lpByTicketId.set(c.hubspotTicketId, c);
  }
  console.log(`[audit]   ${lpByTicketId.size} LP customers have hubspot_ticket_id`);

  // Pre-fetch tickets-per-contact for every unique HS contact involved
  // (both formally associated AND those found via HS search later — we
  // backfill those second).
  console.log('[audit] Fetching contact → tickets associations…');
  const contactTickets = new Map<string, string[]>();
  for (const cid of allContactIds) {
    const ts = await fetchContactTickets(hs, cid);
    contactTickets.set(cid, ts);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`[audit]   fetched ticket associations for ${contactTickets.size} contacts`);

  // Load Rejig snapshot CSV
  const rejigCsv = fs.existsSync('scripts/data/rejig-accounts-snapshot.csv')
    ? fs.readFileSync('scripts/data/rejig-accounts-snapshot.csv', 'utf-8').toLowerCase()
    : '';

  type Row = {
    ticket_id: string;
    stage: string;
    subject: string;
    create_date: string;
    last_modified: string;
    contact_email: string;
    contact_name: string;
    contact_company: string;
    match_method: string;
    lp_customer_id: string;
    lp_customer_name: string;
    lp_customer_email: string;
    lp_state: string;
    lp_subscription_status: string;
    lp_ticket_id: string;
    in_rejig_snapshot: string;
    suggested_action: string;
  };

  const rows: Row[] = [];
  let stats = {
    emailMatch: 0, nameMatch: 0, companyMatch: 0, subjectMatch: 0, graphMatch: 0, hsSearchMatch: 0,
    noMatch: 0, noContact: 0, inRejig: 0,
  };

  // Helper: try LP match given a contact (email + firstname + lastname + company).
  // Returns [matchMethod, lpRow] or [undefined, undefined].
  function tryLpMatch(
    cEmail: string, cFirst: string, cLast: string, cCompany: string,
  ): [string | undefined, typeof allLp[0] | undefined] {
    // 1. Email exact
    if (cEmail && lpByEmail.has(cEmail)) {
      return ['EMAIL_EXACT', lpByEmail.get(cEmail)];
    }
    // 2. Name fuzzy
    if (cFirst && cLast) {
      const fn = cFirst.toLowerCase(); const ln = cLast.toLowerCase();
      const cands = lpFuzzy.filter((x) => x.name.includes(fn) && x.name.includes(ln));
      if (cands.length === 1) return ['NAME_FUZZY', cands[0].row];
      if (cands.length > 1) return [`NAME_FUZZY_AMBIGUOUS_${cands.length}`, undefined];
    }
    // 3. Company fuzzy
    if (cCompany) {
      const co = cCompany.toLowerCase();
      const cands = lpFuzzy.filter((x) => x.business && (x.business.includes(co) || co.includes(x.business)));
      if (cands.length === 1) return ['COMPANY_FUZZY', cands[0].row];
      if (cands.length > 1) return [`COMPANY_FUZZY_AMBIGUOUS_${cands.length}`, undefined];
    }
    return [undefined, undefined];
  }

  for (const t of tickets) {
    let contact = t.contactIds.map((id) => contactsMap.get(id)).find(Boolean);
    let usedHsSearch = false;
    const subjectName = parseSubject(t.subject);

    // Strategy 5 fallback: if no associated contact, search HS Contacts by subject
    if (!contact && subjectName) {
      const found = await searchHsContactsByName(hs, subjectName);
      await new Promise((r) => setTimeout(r, 400));
      if (found.length === 1) {
        contact = found[0];
        usedHsSearch = true;
      } else if (found.length > 1) {
        // Prefer exact firstname+lastname match in results
        const parts = subjectName.toLowerCase().split(' ');
        const exact = found.filter((c) =>
          parts.every((p) => `${c.firstName} ${c.lastName}`.toLowerCase().includes(p)),
        );
        if (exact.length === 1) {
          contact = exact[0];
          usedHsSearch = true;
        }
      }
    }

    const email = contact?.email || '';
    const fullName = contact ? `${contact.firstName} ${contact.lastName}`.trim() : '';
    const company = contact?.company || '';

    let [matchMethod, lpRow] = tryLpMatch(email, contact?.firstName || '', contact?.lastName || '', company);

    // Strategy 4: subject-based LP match (catches "Dameron Group" → "The Dameron Group")
    if (!lpRow && subjectName) {
      const sn = subjectName.toLowerCase();
      const parts = sn.split(' ').filter((p) => p.length > 2);
      const cands = lpFuzzy.filter((x) => {
        // ALL non-trivial subject tokens must appear in either name or business
        const hay = `${x.name} ${x.business}`;
        return parts.length >= 1 && parts.every((p) => hay.includes(p));
      });
      if (cands.length === 1) {
        lpRow = cands[0].row;
        matchMethod = 'SUBJECT_NAME';
      } else if (cands.length > 1) {
        matchMethod = matchMethod || `SUBJECT_NAME_AMBIGUOUS_${cands.length}`;
      }
    }

    // Strategy 6: CONTACT_GRAPH — for each candidate contact (formally
    // associated OR found via HS search), look at that contact's OTHER
    // tickets and check if any are LP-managed (i.e., live in
    // customer.hubspotTicketId). If yes, that LP customer is the owner.
    // Catches B2B/team cases like "Dawn Landau (contact) ↔ Team Environs
    // (LP customer)" where email/name/company never match directly.
    if (!lpRow) {
      const candidateContactIds = new Set<string>(t.contactIds);
      if (contact && !candidateContactIds.has(contact.id)) {
        candidateContactIds.add(contact.id);
      }
      const graphHits: { lp: typeof allLp[0]; viaContactId: string; viaTicketId: string }[] = [];
      for (const cid of candidateContactIds) {
        let related = contactTickets.get(cid);
        if (related === undefined) {
          // Contact found via HS search, not in our pre-fetched map — fetch now
          related = await fetchContactTickets(hs, cid);
          contactTickets.set(cid, related);
          await new Promise((r) => setTimeout(r, 400));
        }
        for (const otherTicketId of related) {
          if (otherTicketId === t.id) continue; // skip self
          const owner = lpByTicketId.get(otherTicketId);
          if (owner) graphHits.push({ lp: owner, viaContactId: cid, viaTicketId: otherTicketId });
        }
      }
      // Dedupe by LP id; take the first (any LP-managed sibling proves ownership)
      const unique = new Map<string, typeof graphHits[0]>();
      for (const h of graphHits) if (!unique.has(h.lp.id)) unique.set(h.lp.id, h);
      if (unique.size === 1) {
        const hit = [...unique.values()][0];
        lpRow = hit.lp;
        matchMethod = 'CONTACT_GRAPH';
      } else if (unique.size > 1) {
        matchMethod = matchMethod || `CONTACT_GRAPH_AMBIGUOUS_${unique.size}`;
      }
    }

    if (matchMethod === 'EMAIL_EXACT') stats.emailMatch++;
    else if (matchMethod === 'NAME_FUZZY') stats.nameMatch++;
    else if (matchMethod === 'COMPANY_FUZZY') stats.companyMatch++;
    else if (matchMethod === 'SUBJECT_NAME') stats.subjectMatch++;
    else if (matchMethod === 'CONTACT_GRAPH') stats.graphMatch++;
    if (usedHsSearch && lpRow) stats.hsSearchMatch++;
    if (!contact) stats.noContact++;
    else if (!lpRow) stats.noMatch++;

    const inRejig = email && rejigCsv.includes(email) ? 'yes' : email ? 'no' : '';
    if (inRejig === 'yes') stats.inRejig++;

    let action = '';
    if (lpRow) {
      action = `reroute_lp_ticket_to=${t.id}`;
    } else if (!contact) {
      action = 'archive_or_lost';
    } else if (inRejig === 'yes') {
      action = 'backfill_to_lp';
    } else {
      action = 'review_then_lost';
    }

    rows.push({
      ticket_id: t.id,
      stage: STAGE_LABEL[t.stage] || t.stage,
      subject: t.subject,
      create_date: t.createDate.slice(0, 10),
      last_modified: t.lastModified.slice(0, 10),
      contact_email: email,
      contact_name: fullName,
      contact_company: company,
      match_method: (matchMethod || (contact ? 'UNMATCHED' : 'NO_CONTACT')) + (usedHsSearch ? '_VIA_HS_SEARCH' : ''),
      lp_customer_id: lpRow?.id ?? '',
      lp_customer_name: lpRow?.name ?? '',
      lp_customer_email: lpRow?.contactEmail ?? '',
      lp_state: lpRow?.onboardingState ?? '',
      lp_subscription_status: lpRow?.subscriptionStatus ?? '',
      lp_ticket_id: lpRow?.hubspotTicketId ?? '',
      in_rejig_snapshot: inRejig,
      suggested_action: action,
    });
  }

  // Sort by suggested action, then stage
  rows.sort((a, b) => a.suggested_action.localeCompare(b.suggested_action) || a.stage.localeCompare(b.stage));

  // Write CSV
  const today = new Date().toISOString().slice(0, 10);
  const outPath = `scripts/data/orphan-cj-audit-${today}.csv`;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => csvEscape((r as any)[h])).join(',')),
  ];
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n');
  console.log(`\n[audit] Wrote ${rows.length} rows to ${outPath}`);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Total legacy-stage tickets:       ${tickets.length}`);
  console.log(`  Matched LP by email:            ${stats.emailMatch}`);
  console.log(`  Matched LP by name (unique):    ${stats.nameMatch}`);
  console.log(`  Matched LP by company (unique): ${stats.companyMatch}`);
  console.log(`  Matched LP by subject:          ${stats.subjectMatch}`);
  console.log(`  Matched LP by CONTACT_GRAPH:    ${stats.graphMatch}`);
  console.log(`  Of those, via HS search:        ${stats.hsSearchMatch}`);
  console.log(`  No match found:                 ${stats.noMatch}`);
  console.log(`  No contact at all:              ${stats.noContact}`);
  console.log(`  Email in Rejig snapshot:        ${stats.inRejig}`);

  console.log('\n=== suggested_action distribution ===');
  const actionCount = new Map<string, number>();
  for (const r of rows) actionCount.set(r.suggested_action, (actionCount.get(r.suggested_action) ?? 0) + 1);
  for (const [a, n] of [...actionCount.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${a.padEnd(36)} ${n}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
