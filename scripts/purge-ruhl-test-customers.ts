import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Purge the Ruhl service-option test customers created via /ruhl/test.
 *
 * Deliberately NOT scripts/purge-test-customers.ts: that one re-derives its
 * list from name/environment heuristics plus some hardcoded names from an old
 * cleanup, so it also matches the real "Jared Wheelock" row. It also reads
 * HUBSPOT_PRIVATE_APP_TOKEN, which isn't set here (we use HUBSPOT_STATIC_TOKEN),
 * so its HubSpot archive step silently no-ops and orphans the tickets.
 *
 * This script takes an explicit id list and refuses anything that isn't
 * tagged environment @> {test}, so it can't wander into real customers.
 *
 * Per customer: archive the HubSpot ticket, then delete the LP row. The delete
 * cascades to tasks, task_dependencies, events, calls, customer_subscriptions
 * and internal_notes; brokerage_roster.customer_id is ON DELETE SET NULL.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/purge-ruhl-test-customers.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/purge-ruhl-test-customers.ts --apply
 */

/**
 * Defaults to every customer tagged environment @> {test}. Pass explicit ids
 * as arguments to narrow it. The test tag is the safety rail either way — an
 * untagged row is refused even if you name its id.
 */
const PURGE_IDS = process.argv.filter((a) => /^[0-9a-f-]{36}$/.test(a));

async function archiveHsTicket(ticketId: string, label: string, apply: boolean) {
  const token = process.env.HUBSPOT_STATIC_TOKEN;
  if (!token) {
    console.log('     HS archive SKIPPED — HUBSPOT_STATIC_TOKEN not set');
    return;
  }
  if (!apply) {
    console.log(`     would archive HS ticket ${ticketId}`);
    return;
  }
  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok || res.status === 204) console.log(`     ✓ archived HS ticket ${ticketId}`);
  else if (res.status === 404) console.log(`     · HS ticket ${ticketId} already gone (404)`);
  else console.log(`     ✗ HS archive failed for ${ticketId} (${label}): ${res.status}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { db } = await import('../src/db');
  const s = await import('../src/db/schema');
  const { inArray, eq, sql } = await import('drizzle-orm');

  console.log(`\nMode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  const cols = {
    id: s.customers.id,
    name: s.customers.name,
    env: s.customers.environment,
    ticket: s.customers.hubspotTicketId,
  };
  const rows = PURGE_IDS.length
    ? await db.select(cols).from(s.customers).where(inArray(s.customers.id, PURGE_IDS))
    : await db.select(cols).from(s.customers).where(sql`${s.customers.environment} @> '{test}'`);

  console.log(PURGE_IDS.length
    ? `Named ${PURGE_IDS.length} id(s), found ${rows.length}.`
    : `All test-tagged customers: ${rows.length}.`);
  if (!rows.length) { console.log('Nothing to purge.\n'); process.exit(0); }

  for (const c of rows) {
    const env = (c.env ?? []) as string[];
    // Hard safety rail: never delete a row that isn't tagged as a test.
    if (!env.includes('test')) {
      console.log(`  ✗ REFUSING ${c.name} — environment=${JSON.stringify(env)}, not tagged test.`);
      continue;
    }
    console.log(`  ${c.name}  (${c.id.slice(0, 8)})`);
    if (c.ticket) await archiveHsTicket(c.ticket, c.name, apply);
    else console.log('     no HS ticket');

    if (apply) {
      const deleted = await db.delete(s.customers).where(eq(s.customers.id, c.id)).returning({ id: s.customers.id });
      console.log(`     ${deleted.length ? '✓ deleted LP customer' : '· LP row already gone'}`);
    } else {
      console.log('     would delete LP customer (cascades tasks/events/calls)');
    }
  }

  console.log(`\n${apply ? 'DONE.' : 'Dry run — re-run with --apply.'}\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
