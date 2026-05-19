/**
 * Find HS tickets that are duplicates of LP-managed tickets — using the
 * full matching strategy set, INCLUDING email-domain matching.
 *
 * Designed to be re-run after weekly cron creates new LP customers, since
 * each new LP customer creates a new HS Contact + Ticket that may duplicate
 * pre-existing pre-LP HS records.
 *
 * Strategies (priority order):
 *   1. EMAIL_EXACT         — orphan contact email == LP contact_email / platform_email
 *   2. NAME_FUZZY          — orphan contact firstname+lastname both appear in LP.name
 *   3. SUBJECT_NAME        — parsed ticket subject tokens all appear in LP.name + business
 *   4. CONTACT_GRAPH       — orphan contact's other tickets include an LP-managed one
 *   5. EMAIL_DOMAIN        — orphan contact email DOMAIN matches an LP customer's email
 *                            domain AND (a) only one LP customer has that domain, or
 *                            (b) name tokens overlap. Catches cases like:
 *                            chris@revelrec.com → care@revelrec.com (Revel Real Estate)
 *
 * Scans all tickets in pipeline 0 (CJ pipeline) EXCEPT those already
 * known to be LP-managed (in customer.hubspotTicketId set). For each,
 * tries to find an LP customer match. Reports candidates for review.
 *
 *   npx tsx --env-file=.env.local scripts/find-hs-lp-dups-with-domain.ts
 *
 * Output: scripts/data/hs-lp-dups-{date}.csv
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import * as fs from 'fs';

const COMMON_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'kw.com', 'bairdwarner.com', 'keyes.com', 'compass.com', 'serhant.com',
]);

type Contact = { id: string; email: string; firstName: string; lastName: string; company: string };

function parseSubject(s: string): string {
  let x = s.trim();
  x = x.replace(/\s*[—–-]\s*(CJ|CSM|LP)\s*$/i, '').trim();
  x = x.replace(/\s*\([^)]+\)\s*/g, '').trim();
  return x.replace(/\s+/g, ' ');
}

function emailDomain(email: string): string {
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

function csvEscape(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });

  // === Load LP data ===
  const allLp = await db.query.customers.findMany();
  const lpByEmail = new Map<string, typeof allLp[0]>();
  const lpTicketIds = new Set<string>();
  const lpByDomain = new Map<string, typeof allLp[0][]>();
  for (const c of allLp) {
    if (c.contactEmail) lpByEmail.set(c.contactEmail.toLowerCase(), c);
    if (c.platformEmail) lpByEmail.set(c.platformEmail.toLowerCase(), c);
    if (c.hubspotTicketId) lpTicketIds.add(c.hubspotTicketId);
    for (const e of [c.contactEmail, c.platformEmail]) {
      if (!e) continue;
      const d = emailDomain(e.toLowerCase());
      if (!d || COMMON_DOMAINS.has(d)) continue;
      if (!lpByDomain.has(d)) lpByDomain.set(d, []);
      lpByDomain.get(d)!.push(c);
    }
  }
  const lpFuzzy = allLp.map((c) => ({
    row: c,
    name: (c.name || '').toLowerCase(),
    business: (c.businessName || '').toLowerCase(),
  }));
  console.log(`[scan] Loaded ${allLp.length} LP customers (${lpTicketIds.size} with HS ticket, ${lpByDomain.size} unique business domains)`);

  // === Fetch all tickets in pipeline 0 ===
  const tickets: { id: string; subject: string; stage: string; contactIds: string[] }[] = [];
  let after: string | undefined;
  let page = 0;
  do {
    const r = await hs.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: '0' } as any] }],
      properties: ['subject', 'hs_pipeline_stage'], sorts: ['hs_object_id'], limit: 100, after,
    });
    for (const t of r.results) {
      if (lpTicketIds.has(t.id)) continue; // skip already-LP-managed
      tickets.push({
        id: t.id,
        subject: (t.properties.subject as string) || '',
        stage: (t.properties.hs_pipeline_stage as string) || '',
        contactIds: [],
      });
    }
    after = r.paging?.next?.after;
    page++;
    await new Promise((r) => setTimeout(r, 500));
    if (page > 30) break;
  } while (after);
  console.log(`[scan] ${tickets.length} non-LP-managed tickets in pipeline 0`);

  // === Fetch contact associations ===
  for (const t of tickets) {
    try {
      const a = await hs.crm.associations.v4.basicApi.getPage('tickets', t.id, 'contacts');
      t.contactIds = a.results.map((r) => String(r.toObjectId));
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  // === Fetch contact details ===
  const allCids = [...new Set(tickets.flatMap((t) => t.contactIds))];
  const contacts = new Map<string, Contact>();
  for (let i = 0; i < allCids.length; i += 50) {
    const batch = allCids.slice(i, i + 50);
    try {
      const r = await hs.crm.contacts.batchApi.read({
        inputs: batch.map((id) => ({ id })),
        properties: ['email', 'firstname', 'lastname', 'company'],
      } as any);
      for (const c of r.results) {
        const p = c.properties as any;
        contacts.set(c.id, {
          id: c.id,
          email: (p.email || '').toLowerCase(),
          firstName: p.firstname || '',
          lastName: p.lastname || '',
          company: p.company || '',
        });
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  // === Pre-fetch contact → tickets ===
  const cTickets = new Map<string, string[]>();
  for (const cid of allCids) {
    try {
      const a = await hs.crm.associations.v4.basicApi.getPage('contacts', cid, 'tickets');
      cTickets.set(cid, a.results.map((r) => String(r.toObjectId)));
    } catch { cTickets.set(cid, []); }
    await new Promise((r) => setTimeout(r, 300));
  }

  // === Match ===
  const rows: any[] = [];
  let stats = { email: 0, name: 0, subject: 0, graph: 0, domain: 0, none: 0 };

  for (const t of tickets) {
    const contact = t.contactIds.map((id) => contacts.get(id)).find(Boolean);
    const email = contact?.email || '';
    const subj = parseSubject(t.subject);
    let method = '';
    let lp: typeof allLp[0] | undefined;

    // 1. EMAIL_EXACT
    if (email && lpByEmail.has(email)) { lp = lpByEmail.get(email); method = 'EMAIL_EXACT'; }

    // 2. NAME_FUZZY
    if (!lp && contact?.firstName && contact?.lastName) {
      const fn = contact.firstName.toLowerCase(), ln = contact.lastName.toLowerCase();
      const c = lpFuzzy.filter((x) => x.name.includes(fn) && x.name.includes(ln));
      if (c.length === 1) { lp = c[0].row; method = 'NAME_FUZZY'; }
    }

    // 3. SUBJECT_NAME
    if (!lp && subj) {
      const parts = subj.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
      const c = lpFuzzy.filter((x) => parts.every((p) => `${x.name} ${x.business}`.includes(p)));
      if (c.length === 1) { lp = c[0].row; method = 'SUBJECT_NAME'; }
    }

    // 4. CONTACT_GRAPH
    if (!lp) {
      const cids = new Set(t.contactIds);
      if (contact) cids.add(contact.id);
      for (const cid of cids) {
        const others = cTickets.get(cid) || [];
        for (const oid of others) {
          if (oid === t.id) continue;
          // Look up LP customer that owns this other ticket
          const owner = allLp.find((c) => c.hubspotTicketId === oid);
          if (owner) { lp = owner; method = 'CONTACT_GRAPH'; break; }
        }
        if (lp) break;
      }
    }

    // 5. EMAIL_DOMAIN — NEW
    if (!lp && email) {
      const d = emailDomain(email);
      if (d && !COMMON_DOMAINS.has(d)) {
        const cands = lpByDomain.get(d) || [];
        if (cands.length === 1) {
          lp = cands[0]; method = 'EMAIL_DOMAIN';
        } else if (cands.length > 1 && contact?.lastName) {
          // Disambiguate by last name in LP name/business
          const ln = contact.lastName.toLowerCase();
          const filtered = cands.filter((c) => ((c.name || '') + ' ' + (c.businessName || '')).toLowerCase().includes(ln));
          if (filtered.length === 1) { lp = filtered[0]; method = 'EMAIL_DOMAIN_LASTNAME'; }
        }
      }
    }

    if (method === 'EMAIL_EXACT') stats.email++;
    else if (method === 'NAME_FUZZY') stats.name++;
    else if (method === 'SUBJECT_NAME') stats.subject++;
    else if (method === 'CONTACT_GRAPH') stats.graph++;
    else if (method.startsWith('EMAIL_DOMAIN')) stats.domain++;
    else stats.none++;

    rows.push({
      ticket_id: t.id,
      stage: t.stage,
      subject: t.subject,
      contact_email: email,
      contact_name: contact ? `${contact.firstName} ${contact.lastName}`.trim() : '',
      contact_domain: emailDomain(email),
      match_method: method || 'NO_MATCH',
      lp_customer_id: lp?.id ?? '',
      lp_customer_name: lp?.name ?? '',
      lp_customer_email: lp?.contactEmail ?? '',
      lp_managed_ticket_id: lp?.hubspotTicketId ?? '',
      lp_state: lp?.onboardingState ?? '',
      suggested_action: lp ? 'archive_dup' : 'review',
    });
  }

  // Output
  rows.sort((a, b) => a.suggested_action.localeCompare(b.suggested_action) || a.match_method.localeCompare(b.match_method));
  const outPath = `scripts/data/hs-lp-dups-${new Date().toISOString().slice(0, 10)}.csv`;
  const cols = Object.keys(rows[0]);
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => csvEscape((r as any)[c])).join(','));
  fs.writeFileSync(outPath, out.join('\n') + '\n');

  console.log('\n=== SUMMARY ===');
  console.log(`Total non-LP-managed tickets scanned: ${tickets.length}`);
  console.log(`  EMAIL_EXACT:           ${stats.email}`);
  console.log(`  NAME_FUZZY:            ${stats.name}`);
  console.log(`  SUBJECT_NAME:          ${stats.subject}`);
  console.log(`  CONTACT_GRAPH:         ${stats.graph}`);
  console.log(`  EMAIL_DOMAIN (new):    ${stats.domain}`);
  console.log(`  NO_MATCH:              ${stats.none}`);
  console.log(`\nWrote ${rows.length} rows to ${outPath}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
