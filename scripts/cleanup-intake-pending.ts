/**
 * Cleanup the 73 Intake Pending tickets per 2026-05-18 user decisions.
 *
 *   1. Delete the 23 LP-managed-twin pre-LP tickets (no history worth keeping;
 *      LP-managed ticket is already canonical).
 *   2. Re-match the 45 NO_CONTACT tickets after stripping the Zap-bug
 *      "l"/"|" prefix from first names (e.g. "Matt lFarley" → "Matt Farley").
 *      Whatever matches → delete. Whatever doesn't → archive (no contact
 *      means no real human; safe to soft-delete).
 *   3. Skip the 5 unmatched-with-contact for now — separate decision.
 *
 *   npx tsx --env-file=.env.local scripts/cleanup-intake-pending.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/cleanup-intake-pending.ts --apply  # execute
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import * as fs from 'fs';

const APPLY = process.argv.includes('--apply');
const CSV_PATH = 'scripts/data/intake-pending-audit-2026-05-18.csv';

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

/**
 * Strip the Zap intake-form bug: a leading "l" or "|" before a capital
 * letter in the last name. e.g.:
 *   "Matt lFarley"       → "Matt Farley"
 *   "Daniel lDemott"     → "Daniel Demott"
 *   "Laura lMiller Edwards" → "Laura Miller Edwards"
 * The pattern is always {firstname} {l|pipe}{capitalized-rest}.
 */
function demangleSubject(subj: string): string {
  // Drop the " - CJ" / " — CJ" suffix first
  let s = subj.replace(/\s*[—–-]\s*(CJ|CSM|LP)\s*$/i, '').trim();
  // Strip leading l/| before each capital-letter token
  s = s.replace(/\b[l|]([A-Z])/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });
  const lines = fs.readFileSync(CSV_PATH, 'utf-8').split('\n').filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const idx = (h: string) => headers.indexOf(h);

  // Parse rows by suggested_action
  const rerouteRows: { ticket_id: string; subject: string; lp_name: string }[] = [];
  const noContactRows: { ticket_id: string; subject: string }[] = [];
  const unmatchedRows: { ticket_id: string; subject: string; contact_email: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const action = c[idx('suggested_action')] || '';
    const ticket = c[idx('ticket_id')];
    const subject = c[idx('subject')];
    if (action.startsWith('reroute_lp_ticket_to=')) {
      rerouteRows.push({ ticket_id: ticket, subject, lp_name: c[idx('lp_customer_name')] || '' });
    } else if (c[idx('match_method')] === 'NO_CONTACT') {
      noContactRows.push({ ticket_id: ticket, subject });
    } else {
      unmatchedRows.push({ ticket_id: ticket, subject, contact_email: c[idx('contact_email')] || '' });
    }
  }

  console.log(`[cleanup] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[cleanup] reroute_delete: ${rerouteRows.length}, no_contact: ${noContactRows.length}, unmatched (skip): ${unmatchedRows.length}`);

  // === Phase 1: Delete the 23 LP-managed-twin pre-LP tickets ===
  console.log('\n━━━ PHASE 1: Delete 23 pre-LP tickets (LP twin is canonical) ━━━');
  let p1Ok = 0, p1Fail = 0;
  for (const r of rerouteRows) {
    console.log(`• ${r.subject.padEnd(48)} ticket=${r.ticket_id}  (LP: ${r.lp_name.slice(0, 30)})`);
    if (APPLY) {
      try {
        await hs.crm.tickets.basicApi.archive(r.ticket_id);
        p1Ok++;
      } catch (e) {
        console.log(`  ✗ ${e instanceof Error ? e.message : e}`);
        p1Fail++;
      }
      await new Promise((s) => setTimeout(s, 350));
    } else { p1Ok++; }
  }

  // === Phase 2: 45 NO_CONTACT — de-mangle name, re-match LP ===
  console.log('\n━━━ PHASE 2: 45 NO_CONTACT — de-mangle subject + re-match LP ━━━');
  const allLp = await db.query.customers.findMany();
  const lpFuzzy = allLp.map((c) => ({
    row: c,
    name: (c.name || '').toLowerCase(),
    business: (c.businessName || '').toLowerCase(),
  }));

  let p2Match = 0, p2Archive = 0, p2Fail = 0;
  const p2Rows: { ticket: string; original: string; demangled: string; outcome: string; lp_name: string }[] = [];

  for (const r of noContactRows) {
    const cleaned = demangleSubject(r.subject);
    const parts = cleaned.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
    const candidates = lpFuzzy.filter((x) => parts.length >= 2 && parts.every((p) => `${x.name} ${x.business}`.includes(p)));

    let outcome = 'archive';
    let lpName = '';
    let lp: typeof allLp[0] | undefined;
    if (candidates.length === 1) {
      lp = candidates[0].row;
      lpName = lp.name || '';
      outcome = `match_delete (LP: ${lpName.slice(0, 35)})`;
      p2Match++;
    } else if (candidates.length > 1) {
      outcome = `AMBIGUOUS (${candidates.length} cands)`;
    } else {
      outcome = 'archive (no LP match)';
      p2Archive++;
    }

    p2Rows.push({ ticket: r.ticket_id, original: r.subject, demangled: cleaned, outcome, lp_name: lpName });

    if (APPLY) {
      try {
        // Always archive (whether matched or not — matched means we have LP canonical, unmatched means orphan garbage)
        await hs.crm.tickets.basicApi.archive(r.ticket_id);
      } catch (e) {
        console.log(`  ✗ archive failed: ${r.ticket_id} | ${e instanceof Error ? e.message : e}`);
        p2Fail++;
      }
      await new Promise((s) => setTimeout(s, 350));
    }
  }

  // Print the Phase 2 table
  console.log('\nPhase 2 details:');
  for (const r of p2Rows) {
    const arrow = r.original === r.demangled ? '' : `→ "${r.demangled}"`;
    console.log(`  ${r.ticket.padEnd(12)} "${r.original.slice(0, 35)}" ${arrow.padEnd(40)} ${r.outcome}`);
  }

  console.log('\n━━━ SUMMARY ━━━');
  console.log(`Phase 1 (delete pre-LP twins): ${p1Ok} ok, ${p1Fail} fail`);
  console.log(`Phase 2 NO_CONTACT:`);
  console.log(`  Matched LP (would delete):  ${p2Match}`);
  console.log(`  Pure orphan (archive):       ${p2Archive}`);
  console.log(`  Errors:                      ${p2Fail}`);
  console.log(`Unmatched-with-contact (skipped, ${unmatchedRows.length}):`);
  for (const u of unmatchedRows) console.log(`  ${u.ticket} | ${u.subject.slice(0, 50)} | ${u.contact_email}`);
  console.log(APPLY ? '\n✓ Applied' : '\n(dry-run — re-run with --apply to execute)');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
