/**
 * Run the consolidator over the pending-reroutes CSV.
 *
 * Reads scripts/data/pending-reroutes-2026-05-18.csv (or path passed via
 * --csv=). For each row:
 *   - orphan_ticket_id (OLD CJ ticket — keep)
 *   - lp_managed_ticket_id (NEW LP ticket — archive)
 *   - Look up LP customer by lp_managed_ticket_id (since CSV doesn't carry
 *     LP UUID directly)
 * Then runs the same consolidation steps as scripts/consolidate-orphan-cj-tickets.ts.
 *
 * Skips rows where my_notes column contains WRONG or skip (case-insensitive).
 *
 *   npx tsx --env-file=.env.local scripts/consolidate-from-csv.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/consolidate-from-csv.ts --apply    # execute
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { eq, inArray } from 'drizzle-orm';
import * as fs from 'fs';

const APPLY = process.argv.includes('--apply');
const csvArg = process.argv.find((a) => a.startsWith('--csv='));
const CSV_PATH = csvArg ? csvArg.split('=')[1] : 'scripts/data/pending-reroutes-2026-05-18.csv';

const BI_TICKET_PROPS = [
  'hs_pipeline_stage',
  'rejig_attention_reason',
  'rejig_attention_set_at',
  'rejig_recommended_action',
  'rejig_recommended_action_urgency',
  'rejig_recommended_action_set_at',
];

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

async function readBiProps(hs: Client, ticketId: string): Promise<Record<string, string> | null> {
  try {
    const t = await hs.crm.tickets.basicApi.getById(ticketId, BI_TICKET_PROPS);
    const out: Record<string, string> = {};
    for (const k of BI_TICKET_PROPS) {
      const v = (t.properties as any)[k];
      if (v != null && v !== '') out[k] = v;
    }
    return out;
  } catch (e: any) {
    if (e.code === 404) return null;
    throw e;
  }
}

async function archiveIfExists(hs: Client, ticketId: string): Promise<boolean> {
  try { await hs.crm.tickets.basicApi.archive(ticketId); return true; }
  catch (e: any) { if (e.code === 404) return false; throw e; }
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });

  const lines = fs.readFileSync(CSV_PATH, 'utf-8').split('\n').filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const idx = (h: string) => headers.indexOf(h);

  type Row = { orphan: string; lp_ticket: string; lp_name: string; notes: string; subject: string };
  const allRows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    allRows.push({
      orphan: c[idx('orphan_ticket_id')],
      lp_ticket: c[idx('lp_managed_ticket_id')],
      lp_name: c[idx('lp_customer_name')] || '',
      notes: (c[idx('my_notes')] || '').toLowerCase(),
      subject: c[idx('subject')] || '',
    });
  }
  console.log(`[consolidate] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  CSV=${CSV_PATH}`);
  console.log(`[consolidate] total rows: ${allRows.length}`);

  // Filter: skip rows where my_notes contains WRONG or skip
  const rows = allRows.filter((r) => {
    if (r.notes.includes('wrong') || r.notes.includes('skip')) {
      console.log(`  skipped (my_notes=${r.notes}): ${r.subject}`);
      return false;
    }
    if (!r.orphan || !r.lp_ticket) {
      console.log(`  skipped (missing ids): ${r.subject}`);
      return false;
    }
    return true;
  });
  console.log(`[consolidate] processing: ${rows.length}\n`);

  // Resolve LP customer ID for each lp_managed_ticket_id (one query)
  const lpRows = await db.query.customers.findMany({ where: inArray(customers.hubspotTicketId, rows.map((r) => r.lp_ticket)) });
  const lpByTicket = new Map(lpRows.map((r) => [r.hubspotTicketId!, r]));

  let ok = 0, fail = 0, missingLp = 0;
  for (const r of rows) {
    const lp = lpByTicket.get(r.lp_ticket);
    console.log(`\n• ${r.subject.slice(0, 50)}`);
    console.log(`  OLD CJ: ${r.orphan}  NEW LP: ${r.lp_ticket}  LP: ${r.lp_name}`);
    if (!lp) {
      console.log('  ⚠ LP customer not found by hubspot_ticket_id — skipping');
      missingLp++;
      continue;
    }
    try {
      const props = await readBiProps(hs, r.lp_ticket);
      if (props === null) console.log('  [read] NEW already archived (404)');
      else console.log(`  [read] NEW props: ${Object.keys(props).join(', ')}`);
      await new Promise((s) => setTimeout(s, 400));

      if (APPLY) {
        if (props && Object.keys(props).length > 0) {
          await hs.crm.tickets.basicApi.update(r.orphan, { properties: props });
          console.log('  [write] OLD updated with BI props + stage');
          await new Promise((s) => setTimeout(s, 400));
        }
        await db.update(customers).set({ hubspotTicketId: r.orphan }).where(eq(customers.id, lp.id));
        console.log(`  [db]    LP customer.hubspot_ticket_id = ${r.orphan}`);
        const archived = await archiveIfExists(hs, r.lp_ticket);
        console.log(archived ? '  [hs]    NEW archived' : '  [hs]    NEW already archived');
        await new Promise((s) => setTimeout(s, 400));
      }
      ok++;
    } catch (e) {
      console.log(`  ✗ ERROR: ${e instanceof Error ? e.message : e}`);
      fail++;
    }
  }

  console.log('\n━━━ SUMMARY ━━━');
  console.log(`Processed: ${ok} ok, ${fail} failed, ${missingLp} missing LP`);
  console.log(APPLY ? '✓ Applied' : '(dry-run — re-run with --apply to execute)');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
