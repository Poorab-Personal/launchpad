/**
 * Audit the 73 HS tickets stuck in "Intake Pending" stage (1154519671).
 *
 * Hypothesis: many are pre-LP-era CJ tickets that should have been
 * consolidated with LP-managed tickets (same Dawn Landau / Team Environs
 * pattern). Some may be true intake-pending (customers in flight).
 *
 * Strategies (re-use from orphan-cj audit):
 *   1. EMAIL_EXACT — formal contact's email matches LP customer
 *   2. NAME_FUZZY — first+last in LP.name
 *   3. SUBJECT_NAME — parsed ticket subject matches LP.name or business
 *   4. CONTACT_GRAPH — contact's other tickets include an LP-managed one
 *
 * Output: scripts/data/intake-pending-audit-{date}.csv
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import * as fs from 'fs';

const STAGE_INTAKE = '1154519671';

type Ticket = {
  id: string;
  subject: string;
  createDate: string;
  contactIds: string[];
};

type Contact = { id: string; email: string; firstName: string; lastName: string; company: string };

function parseSubject(s: string): string {
  let x = s.trim();
  x = x.replace(/\s*[—–-]\s*(CJ|CSM|LP)\s*$/i, '').trim();
  x = x.replace(/\s*\([^)]+\)\s*/g, '').trim();
  return x.replace(/\s+/g, ' ');
}

function csvEscape(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });

  // Fetch all Intake Pending tickets
  const tickets: Ticket[] = [];
  let after: string | undefined;
  let page = 0;
  do {
    const r = await hs.crm.tickets.searchApi.doSearch({
      filterGroups: [{ filters: [
        { propertyName: 'hs_pipeline', operator: 'EQ', value: '0' } as any,
        { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: STAGE_INTAKE } as any,
      ] }],
      properties: ['subject', 'createdate'],
      sorts: ['hs_object_id'],
      limit: 100, after,
    } as any);
    for (const t of r.results) {
      tickets.push({
        id: t.id,
        subject: (t.properties.subject as string) || '',
        createDate: (t.properties.createdate as string) || '',
        contactIds: [],
      });
    }
    after = r.paging?.next?.after;
    page++;
    await new Promise((r) => setTimeout(r, 600));
  } while (after && page < 10);
  console.log(`[audit] Intake Pending tickets: ${tickets.length}`);

  // Fetch contact associations
  for (const t of tickets) {
    try {
      const a = await hs.crm.associations.v4.basicApi.getPage('tickets', t.id, 'contacts');
      t.contactIds = a.results.map((r) => String(r.toObjectId));
    } catch { /* skip */ }
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log('[audit] Contact associations fetched');

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

  // LP data
  const allLp = await db.query.customers.findMany();
  const lpByEmail = new Map<string, typeof allLp[0]>();
  for (const c of allLp) {
    if (c.contactEmail) lpByEmail.set(c.contactEmail.toLowerCase(), c);
    if (c.platformEmail) lpByEmail.set(c.platformEmail.toLowerCase(), c);
  }
  const lpFuzzy = allLp.map((c) => ({
    row: c,
    name: (c.name || '').toLowerCase(),
    business: (c.businessName || '').toLowerCase(),
  }));
  const lpByTicketId = new Map<string, typeof allLp[0]>();
  for (const c of allLp) if (c.hubspotTicketId) lpByTicketId.set(c.hubspotTicketId, c);

  // Pre-fetch contact → tickets
  const cTickets = new Map<string, string[]>();
  for (const cid of allCids) {
    try {
      const a = await hs.crm.associations.v4.basicApi.getPage('contacts', cid, 'tickets');
      cTickets.set(cid, a.results.map((r) => String(r.toObjectId)));
    } catch { cTickets.set(cid, []); }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Categorize each ticket
  const rows: any[] = [];
  let stats = { match: 0, noMatch: 0, noContact: 0 };

  for (const t of tickets) {
    const contact = t.contactIds.map((id) => contacts.get(id)).find(Boolean);
    const email = contact?.email || '';
    const subj = parseSubject(t.subject);

    let method = '';
    let lp: typeof allLp[0] | undefined;

    if (email && lpByEmail.has(email)) { lp = lpByEmail.get(email); method = 'EMAIL_EXACT'; }
    if (!lp && contact?.firstName && contact?.lastName) {
      const fn = contact.firstName.toLowerCase(), ln = contact.lastName.toLowerCase();
      const c = lpFuzzy.filter((x) => x.name.includes(fn) && x.name.includes(ln));
      if (c.length === 1) { lp = c[0].row; method = 'NAME_FUZZY'; }
    }
    if (!lp && subj) {
      const parts = subj.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
      const c = lpFuzzy.filter((x) => parts.every((p) => `${x.name} ${x.business}`.includes(p)));
      if (c.length === 1) { lp = c[0].row; method = 'SUBJECT_NAME'; }
    }
    if (!lp) {
      // Contact graph
      const cids = new Set(t.contactIds);
      if (contact) cids.add(contact.id);
      for (const cid of cids) {
        const others = cTickets.get(cid) || [];
        for (const oid of others) {
          if (oid === t.id) continue;
          const owner = lpByTicketId.get(oid);
          if (owner) { lp = owner; method = 'CONTACT_GRAPH'; break; }
        }
        if (lp) break;
      }
    }

    if (lp) stats.match++;
    else if (!contact) stats.noContact++;
    else stats.noMatch++;

    rows.push({
      ticket_id: t.id,
      subject: t.subject,
      create_date: t.createDate.slice(0, 10),
      contact_email: email,
      contact_name: contact ? `${contact.firstName} ${contact.lastName}`.trim() : '',
      match_method: method || (contact ? 'UNMATCHED' : 'NO_CONTACT'),
      lp_customer_id: lp?.id ?? '',
      lp_customer_name: lp?.name ?? '',
      lp_customer_email: lp?.contactEmail ?? '',
      lp_state: lp?.onboardingState ?? '',
      lp_subscription_status: lp?.subscriptionStatus ?? '',
      lp_managed_ticket_id: lp?.hubspotTicketId ?? '',
      suggested_action: lp ? `reroute_lp_ticket_to=${t.id}` : (contact ? 'review_or_churned' : 'archive_or_lost'),
    });
  }

  // Write
  rows.sort((a, b) => a.suggested_action.localeCompare(b.suggested_action) || a.subject.localeCompare(b.subject));
  const outPath = `scripts/data/intake-pending-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  const cols = Object.keys(rows[0]);
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => csvEscape((r as any)[c])).join(','));
  fs.writeFileSync(outPath, out.join('\n') + '\n');

  console.log('\n=== SUMMARY ===');
  console.log(`Total Intake Pending tickets: ${tickets.length}`);
  console.log(`  Matched to LP (reroute candidate): ${stats.match}`);
  console.log(`  Has contact but no LP match:       ${stats.noMatch}`);
  console.log(`  No contact:                        ${stats.noContact}`);
  console.log(`\nWrote ${rows.length} rows to ${outPath}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
