/**
 * Apply founder's row-by-row overrides to the diagnostic CSV.
 *
 * Founder reviewed the 49 payment_source_unknown rows manually (2026-05-15)
 * and provided per-row directives. This script:
 *   1. Adds two new columns: manual_action, manual_notes
 *   2. Writes the overrides per row (keyed by Rejig _id, not email,
 *      because some emails have duplicate Rejig accounts)
 *   3. Auto-applies "demo" to all UniqueCollective rows
 *
 * manual_action values:
 *   skip            — don't backfill (old account, swapped to another)
 *   demo            — internal/sample/demo; backfill as Active, payment_source=NULL
 *   churn           — cancelled; override onboarding_state to Churned
 *   stripe_pending  — Stripe ID added in Rejig but not yet in local snapshot;
 *                     skip backfill until next Rejig pull
 *   leave_alone     — trialing executive/sponsor; backfill as Active, no Stripe expected
 *   tbd             — undecided; skip until founder confirms
 *
 * Read-only on the diagnostic — appends columns, doesn't change other data.
 * Re-runnable: strips and re-writes manual_action/manual_notes if present.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const csvArg = process.argv.find((a) => a.startsWith('--csv='));
const CSV_PATH = csvArg
  ? csvArg.split('=')[1]
  : `scripts/data/backfill-audit-${new Date().toISOString().slice(0, 10)}.csv`;

const text = readFileSync(CSV_PATH, 'utf8');
const lines = text.split('\n');
const header = lines[0].split(',');

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '', inQ = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '"' && line[j + 1] === '"') { cur += '"'; j++; continue; }
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

function csvEsc(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Per-Rejig-_id overrides — unique per row, avoids email-duplicate ambiguity.
// Optional override fields: hsTicketIdOverride, channelOverride.
type RejigOverride = {
  action: string;
  notes: string;
  hsTicketIdOverride?: string;
  channelOverride?: 'Standard' | 'Keyes' | 'BW';
};
const BY_REJIG_ID: Record<string, RejigOverride> = {
  // R:32 — lisa@treugroup.com (OLD; another lisa row R:543 has live Stripe sub)
  '6911bcd00d29afe171c3bcb7': { action: 'skip', notes: 'old account; user swapped to treugroup-premium.com' },
  // R:34 — loodmy@jacquesrealty.com (OLD; another loodmy row R:549 has Stripe sub)
  '681d9c9b034f03ccf4000dc5': { action: 'skip', notes: 'old account; user swapped to -premium.com' },
  // R:384 — Charles Irving (internal demo)
  '6807510e137fa8cb4d3e654e': { action: 'demo', notes: 'Charles Irving — internal demo account' },
  // R:410 — design.3@rejig.ai (internal demo)
  '67ffbc22b53cceb839d6f2e5': { action: 'demo', notes: 'design.3@rejig.ai — internal demo' },
  // R:418 — Drysdale (BHHS) — trialing potential broker
  '6969e865fc52f42add194e31': { action: 'leave_alone', notes: 'Drysdale Properties — trialing potential broker' },
  // R:434 — gina (Stripe ID added in Rejig today; will appear next pull)
  '695be1cfd521e4146877a212': { action: 'stripe_pending', notes: 'Stripe ID added in Rejig; next pull will have it' },
  // R:451 — VP Group — trialing executive sponsor
  '69d774fc258d8ebc0e1bee39': { action: 'leave_alone', notes: 'VP Group — trialing executive, no Stripe expected' },
  // R:474 — Team Forss (Stripe ID added in Rejig today)
  '69366fc750ea16c95aa5c187': { action: 'stripe_pending', notes: 'Team Forss — Stripe ID added in Rejig' },
  // R:476 — Tristan & Associates — trialing executive sponsor
  '69117cc40d29afe171c3bcad': { action: 'leave_alone', notes: 'Tristan & Associates — trialing executive, no Stripe expected' },
  // R:519 — Kelly Crawford (internal demo)
  '67361fcccfc528e7d24b8a51': { action: 'demo', notes: 'Kelly Crawford — internal demo' },
  // R:586 — Miketech — sponsor exec
  '68dff15b914846ecfbf60275': { action: 'leave_alone', notes: 'Miketech — sponsor exec, free/trialing like VP Group' },
  // R:601 — Nick Baldwin (cancelled, treat as churn)
  '69158fd10d29afe171c3bce3': { action: 'churn', notes: 'Nick Baldwin — cancelled' },
  // R:607 — Kittle Team (Stripe ID added in Rejig)
  '6939b28850ea16c95aa5c1c4': { action: 'stripe_pending', notes: 'Kittle Team — Stripe ID added in Rejig' },
  // R:616 — NEXT Real Estate — sponsor exec
  '695221916044d9885ec902f6': { action: 'leave_alone', notes: 'NEXT Real Estate — sponsor exec, free/trialing' },
  // R:633 — Rob Abercrombie (cancelled)
  '6939191350ea16c95aa5c1aa': { action: 'churn', notes: 'Rob Abercrombie — cancelled' },
  // R:639 — Colorado Mountain Living — founder undecided
  '696675fafc52f42add194e2b': { action: 'tbd', notes: 'Colorado Mountain Living — founder undecided' },
  // R:655 — Shari Zeuner (cancelled)
  '686b648ebe40fee174e8018c': { action: 'churn', notes: 'Shari Zeuner — cancelled' },
  // R:666 — team@ruthkrishnan.com (David John Aaron Museum — demo)
  '665e601fe655e4059a553c3d': { action: 'demo', notes: 'team@ruthkrishnan.com — internal demo' },
  // R:667 — team@ruthkrishnan.com (Ruth Krishnan SF Real Estate — demo)
  '67d2adb2d08933bfb29ce807': { action: 'demo', notes: 'team@ruthkrishnan.com — internal demo (duplicate)' },
  // R:339 — adietz@ipre.com (IPRE demo, per founder)
  '6a045c23d2da0bead6d17c70': { action: 'demo', notes: 'IPRE demo account (founder confirmed)' },
  // R:493 — jhallas@ipre.com (IPRE demo, per founder)
  '6a059d69d2da0bead6d17c7d': { action: 'demo', notes: 'IPRE demo account (founder confirmed)' },

  // ─── Non-payment-source overrides ────────────────────────────────────────
  // R:40 — realtornancystetson@gmail.com (hs_multiple_open_tickets)
  // Founder picks ticket 43821244970 (not the auto-picked 43584434083).
  '69c50049b0680f18b06de9df': {
    action: '',
    notes: 'founder picked specific HS ticket (manual override)',
    hsTicketIdOverride: '43821244970',
  },
  // R:48 — tiffany@miloffaubuchon.com (trial_non_keyes)
  // Founder confirms this trial customer IS Keyes (signals missed).
  '6a043e2ad2da0bead6d17c6b': {
    action: '',
    notes: 'founder confirms channel = Keyes (signals 1-6 missed)',
    channelOverride: 'Keyes',
  },
};

// Strip prior manual_action/manual_notes if re-running
const existingActionIdx = header.indexOf('manual_action');
const existingNotesIdx = header.indexOf('manual_notes');
const stripExisting = existingActionIdx >= 0 && existingNotesIdx >= 0;
const baseHeader = stripExisting
  ? header.filter((h) => h !== 'manual_action' && h !== 'manual_notes')
  : header;
const newIdxEmail = baseHeader.indexOf('rejig_email');
const newIdxBiz = baseHeader.indexOf('rejig_business_name');
const newIdxId = baseHeader.indexOf('rejig_user_id');

// Strip prior override columns too
const existingTicketIdx = baseHeader.indexOf('manual_hs_ticket_id_override');
const existingChannelIdx = baseHeader.indexOf('manual_channel_code_override');
const baseHeader2 = baseHeader.filter(
  (h) => h !== 'manual_hs_ticket_id_override' && h !== 'manual_channel_code_override',
);

const newHeader = [
  ...baseHeader2,
  'manual_action',
  'manual_notes',
  'manual_hs_ticket_id_override',
  'manual_channel_code_override',
];
const outLines: string[] = [newHeader.join(',')];

let appliedById = 0;
let appliedUniqueCollective = 0;
let unchanged = 0;

for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const cellsRaw = parseLine(lines[i]);
  // Strip ALL prior override columns (action, notes, ticket, channel)
  const dropIndexes = new Set<number>();
  if (stripExisting) {
    dropIndexes.add(existingActionIdx);
    dropIndexes.add(existingNotesIdx);
  }
  const t = header.indexOf('manual_hs_ticket_id_override');
  const c = header.indexOf('manual_channel_code_override');
  if (t >= 0) dropIndexes.add(t);
  if (c >= 0) dropIndexes.add(c);
  const cells = cellsRaw.filter((_, k) => !dropIndexes.has(k));
  const rejigId = cells[newIdxId] || '';
  const email = (cells[newIdxEmail] || '').toLowerCase();
  const biz = (cells[newIdxBiz] || '').toLowerCase();

  let action = '';
  let notes = '';
  let ticketOverride = '';
  let channelOverride = '';

  if (BY_REJIG_ID[rejigId]) {
    const ov = BY_REJIG_ID[rejigId];
    action = ov.action;
    notes = ov.notes;
    ticketOverride = ov.hsTicketIdOverride ?? '';
    channelOverride = ov.channelOverride ?? '';
    appliedById++;
  } else if (
    email.includes('@uniquecollective.us')
    || biz.includes('uniquecollective')
    || biz.includes('unique real estate collective')
  ) {
    action = 'demo';
    notes = 'UniqueCollective demo cohort (real customers, not paying/trialing)';
    appliedUniqueCollective++;
  } else {
    unchanged++;
  }

  cells.push(action, notes, ticketOverride, channelOverride);
  outLines.push(cells.map(csvEsc).join(','));
}

writeFileSync(CSV_PATH, outLines.join('\n') + '\n');

console.log(`Applied:`);
console.log(`  By Rejig _id:           ${appliedById} (expected: ${Object.keys(BY_REJIG_ID).length})`);
console.log(`  UniqueCollective auto:  ${appliedUniqueCollective}`);
console.log(`  Unchanged:              ${unchanged}`);
console.log(`Total rows:               ${appliedById + appliedUniqueCollective + unchanged}`);
console.log(`\nWritten: ${CSV_PATH}`);
