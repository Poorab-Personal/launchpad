/**
 * Build the pending reroutes audit CSV for user verification.
 *
 * Combines:
 *   - 30 audit auto-matches (from orphan-cj-audit-2026-05-18.csv where
 *     suggested_action=reroute_lp_ticket_to=*) — but EXCLUDING the 12
 *     we already processed today.
 *   - 8 hidden Contact-duplicates (from orphan-cj-hidden-dupes-2026-05-18.csv)
 *
 * Output: scripts/data/pending-reroutes-2026-05-18.csv
 * Columns: source, orphan_ticket_id, subject, contact_email, contact_name,
 *          match_method, lp_customer_name, lp_customer_email, lp_state,
 *          lp_managed_ticket_id, my_notes
 *
 * User fills `my_notes` only if a row looks wrong. Otherwise we proceed.
 */
import * as fs from 'fs';

function parseCsvLine(line: string): string[] {
  const cells: string[] = []; let cur = '', q = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"') { if (q && line[j + 1] === '"') { cur += '"'; j++; } else q = !q; }
    else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function esc(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// The 12 reroutes already processed today (their orphan ticket IDs)
const ALREADY_DONE = new Set([
  '45181023151', '29394892346', '33436857735', '41534358656', '42588638260',
  '44974169871', '45269764245', '43722816009', '29599814045', '32204116075',
  '37092170905', '38522575447',
]);

type Row = {
  source: string;
  orphan_ticket_id: string;
  subject: string;
  contact_email: string;
  contact_name: string;
  match_method: string;
  lp_customer_name: string;
  lp_customer_email: string;
  lp_state: string;
  lp_managed_ticket_id: string;
  my_notes: string;
};

const rows: Row[] = [];

// Source 1: audit auto-matches
const auditLines = fs.readFileSync('scripts/data/orphan-cj-audit-2026-05-18.csv', 'utf-8').split('\n').filter(Boolean);
const aH = parseCsvLine(auditLines[0]);
const aIdx = (h: string) => aH.indexOf(h);
for (let i = 1; i < auditLines.length; i++) {
  const c = parseCsvLine(auditLines[i]);
  const action = c[aIdx('suggested_action')] || '';
  if (!action.startsWith('reroute_lp_ticket_to=')) continue;
  const tid = c[aIdx('ticket_id')];
  if (ALREADY_DONE.has(tid)) continue;
  rows.push({
    source: 'audit_auto',
    orphan_ticket_id: tid,
    subject: c[aIdx('subject')] || '',
    contact_email: c[aIdx('contact_email')] || '',
    contact_name: c[aIdx('contact_name')] || '',
    match_method: c[aIdx('match_method')] || '',
    lp_customer_name: c[aIdx('lp_customer_name')] || '',
    lp_customer_email: c[aIdx('lp_customer_email')] || '',
    lp_state: c[aIdx('lp_state')] || '',
    lp_managed_ticket_id: c[aIdx('lp_ticket_id')] || '',
    my_notes: '',
  });
}

// Source 2: hidden Contact-dups
if (fs.existsSync('scripts/data/orphan-cj-hidden-dupes-2026-05-18.csv')) {
  const hLines = fs.readFileSync('scripts/data/orphan-cj-hidden-dupes-2026-05-18.csv', 'utf-8').split('\n').filter(Boolean);
  const hH = parseCsvLine(hLines[0]);
  const hIdx = (h: string) => hH.indexOf(h);
  for (let i = 1; i < hLines.length; i++) {
    const c = parseCsvLine(hLines[i]);
    const tid = c[hIdx('orphan_ticket_id')];
    if (ALREADY_DONE.has(tid)) continue;
    rows.push({
      source: 'hidden_contact_dup',
      orphan_ticket_id: tid,
      subject: c[hIdx('orphan_subject')] || '',
      contact_email: c[hIdx('orphan_contact_email')] || '',
      contact_name: c[hIdx('person_name')] || '',
      match_method: 'CONTACT_GRAPH_DEEP',
      lp_customer_name: c[hIdx('lp_customer_name')] || '',
      lp_customer_email: c[hIdx('lp_customer_email')] || '',
      lp_state: c[hIdx('lp_state')] || '',
      lp_managed_ticket_id: c[hIdx('lp_managed_ticket_id')] || '',
      my_notes: '',
    });
  }
}

// Sort by source then subject for ease of review
rows.sort((a, b) => a.source.localeCompare(b.source) || a.subject.localeCompare(b.subject));

const cols = Object.keys(rows[0]) as (keyof Row)[];
const out = [cols.join(',')];
for (const r of rows) out.push(cols.map((c) => esc((r as any)[c])).join(','));

const outPath = 'scripts/data/pending-reroutes-2026-05-18.csv';
fs.writeFileSync(outPath, out.join('\n') + '\n');

console.log(`Wrote ${rows.length} pending reroutes to ${outPath}`);
console.log(`  audit_auto: ${rows.filter((r) => r.source === 'audit_auto').length}`);
console.log(`  hidden_contact_dup: ${rows.filter((r) => r.source === 'hidden_contact_dup').length}`);
