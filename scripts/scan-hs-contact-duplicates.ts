/**
 * Scan for HS Contact duplicates that are hiding LP-customer linkages.
 *
 * Pattern: same human → two HS Contacts (different emails) → one Contact
 * linked to an orphan legacy-stage ticket, the other linked to the
 * LP-managed ticket. Because they're separate Contacts, our earlier
 * audit's CONTACT_GRAPH couldn't traverse between them.
 *
 * For each ticket in the prior audit that landed in review_then_lost or
 * archive_or_lost:
 *   1. Determine the human's first+last name (from associated contact or
 *      parsed from subject).
 *   2. Search HS for ALL contacts with that firstname + lastname (case-
 *      insensitive).
 *   3. For each candidate contact, list its associated tickets.
 *   4. If any of those tickets are LP-managed (in customer.hubspotTicketId),
 *      we've found a hidden duplication: the orphan ticket belongs to the
 *      same human as the LP-managed ticket, just via a different Contact.
 *
 * Output: stdout summary + CSV of all detected duplicates.
 *
 *   npx tsx --env-file=.env.local scripts/scan-hs-contact-duplicates.ts
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import * as fs from 'fs';

type AuditRow = {
  ticket_id: string;
  subject: string;
  contact_email: string;
  contact_name: string;
  match_method: string;
  suggested_action: string;
};

function parseSubjectName(subject: string): string {
  let s = subject.trim();
  s = s.replace(/\s*[—–-]\s*(CJ|CSM)\s*$/i, '').trim();
  s = s.replace(/[—–-]\s*CJ\s*$/i, '').trim();
  s = s.replace(/\s*\([^)]+\)\s*/g, '').trim();
  return s.replace(/\s+/g, ' ');
}

function csvEscape(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });

  // Load prior audit CSV
  const auditPath = 'scripts/data/orphan-cj-audit-2026-05-18.csv';
  if (!fs.existsSync(auditPath)) {
    console.error('Audit CSV not found:', auditPath);
    process.exit(1);
  }
  const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
  const headers = lines[0].split(',');
  const idx = (h: string) => headers.indexOf(h);
  const rows: AuditRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Robust CSV parse: handles quoted fields
    const cells: string[] = [];
    let cur = '', q = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') {
        if (q && lines[i][j + 1] === '"') { cur += '"'; j++; }
        else q = !q;
      } else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push({
      ticket_id: cells[idx('ticket_id')],
      subject: cells[idx('subject')],
      contact_email: cells[idx('contact_email')],
      contact_name: cells[idx('contact_name')],
      match_method: cells[idx('match_method')],
      suggested_action: cells[idx('suggested_action')],
    });
  }

  // Filter to UNMATCHED rows (we want to find what audit missed)
  const candidates = rows.filter((r) =>
    r.suggested_action === 'review_then_lost' || r.suggested_action === 'archive_or_lost',
  );
  console.log(`[scan] Candidates to re-check: ${candidates.length}`);

  // Build LP ticket → customer lookup
  const allLp = await db.query.customers.findMany();
  const lpByTicketId = new Map<string, typeof allLp[0]>();
  for (const c of allLp) if (c.hubspotTicketId) lpByTicketId.set(c.hubspotTicketId, c);
  console.log(`[scan] LP customers with HS ticket: ${lpByTicketId.size}`);

  type Hit = {
    orphan_ticket_id: string;
    orphan_subject: string;
    orphan_contact_email: string;
    person_name: string;
    duplicate_hs_contact_ids: string;
    duplicate_emails: string;
    lp_managed_ticket_id: string;
    lp_customer_name: string;
    lp_customer_email: string;
    lp_state: string;
  };
  const hits: Hit[] = [];
  const contactSearchCache = new Map<string, { id: string; email: string; firstname: string; lastname: string }[]>();
  const ticketsForContactCache = new Map<string, string[]>();

  let progress = 0;
  for (const r of candidates) {
    progress++;
    if (progress % 10 === 0) console.log(`[scan]   ${progress}/${candidates.length}`);

    // Determine person name
    let firstName = '';
    let lastName = '';
    if (r.contact_name) {
      const parts = r.contact_name.split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    } else if (r.subject) {
      const sn = parseSubjectName(r.subject);
      const parts = sn.split(/\s+/);
      if (parts.length >= 2) {
        firstName = parts[0];
        lastName = parts.slice(1).join(' ');
      }
    }
    if (!firstName || !lastName) continue; // can't search

    // Search HS contacts by firstname + lastname (cache key normalized)
    const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
    let contacts = contactSearchCache.get(key);
    if (!contacts) {
      try {
        const res = await hs.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [
              { propertyName: 'firstname', operator: 'EQ', value: firstName } as any,
              { propertyName: 'lastname', operator: 'EQ', value: lastName } as any,
            ],
          }],
          properties: ['email', 'firstname', 'lastname'],
          limit: 20,
        } as any);
        contacts = res.results.map((c) => {
          const p = c.properties as any;
          return {
            id: c.id,
            email: (p.email || '').toLowerCase(),
            firstname: p.firstname || '',
            lastname: p.lastname || '',
          };
        });
        contactSearchCache.set(key, contacts);
      } catch {
        contacts = [];
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (contacts.length < 2) continue; // need at least 2 contacts for a duplicate

    // For each candidate contact, get its tickets and check LP-managed
    for (const c of contacts) {
      let ts = ticketsForContactCache.get(c.id);
      if (ts === undefined) {
        try {
          const a = await hs.crm.associations.v4.basicApi.getPage('contacts', c.id, 'tickets');
          ts = a.results.map((x) => String(x.toObjectId));
        } catch { ts = []; }
        ticketsForContactCache.set(c.id, ts);
        await new Promise((r) => setTimeout(r, 300));
      }
      for (const tid of ts) {
        const lp = lpByTicketId.get(tid);
        if (lp) {
          // Found! Record this hit
          hits.push({
            orphan_ticket_id: r.ticket_id,
            orphan_subject: r.subject,
            orphan_contact_email: r.contact_email,
            person_name: `${firstName} ${lastName}`,
            duplicate_hs_contact_ids: contacts.map((x) => x.id).join('|'),
            duplicate_emails: contacts.map((x) => x.email).filter(Boolean).join('|'),
            lp_managed_ticket_id: tid,
            lp_customer_name: lp.name ?? '',
            lp_customer_email: lp.contactEmail ?? '',
            lp_state: lp.onboardingState ?? '',
          });
          break; // one hit per orphan is enough
        }
      }
      // If we already found a hit for this orphan, stop checking other contacts
      if (hits.length > 0 && hits[hits.length - 1].orphan_ticket_id === r.ticket_id) break;
    }
  }

  // Dedupe hits by orphan_ticket_id
  const seen = new Set<string>();
  const uniq = hits.filter((h) => {
    if (seen.has(h.orphan_ticket_id)) return false;
    seen.add(h.orphan_ticket_id);
    return true;
  });

  console.log(`\n=== RESULTS ===`);
  console.log(`Candidates scanned: ${candidates.length}`);
  console.log(`Hidden duplicates found: ${uniq.length}`);
  console.log(`Still genuinely unmatched: ${candidates.length - uniq.length}`);

  // Write hits to CSV
  const outPath = `scripts/data/orphan-cj-hidden-dupes-${new Date().toISOString().slice(0, 10)}.csv`;
  if (uniq.length > 0) {
    const cols = Object.keys(uniq[0]);
    const out = [cols.join(',')];
    for (const h of uniq) out.push(cols.map((c) => csvEscape((h as any)[c])).join(','));
    fs.writeFileSync(outPath, out.join('\n') + '\n');
    console.log(`\n✓ Wrote ${uniq.length} hidden-dup rows to ${outPath}`);

    console.log('\nSample 5:');
    for (const h of uniq.slice(0, 5)) {
      console.log(`  '${h.orphan_subject.slice(0, 40)}' → LP ${h.lp_customer_name.slice(0, 35)} (state=${h.lp_state})`);
      console.log(`    HS Contacts: ${h.duplicate_hs_contact_ids}`);
      console.log(`    Emails:      ${h.duplicate_emails}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
