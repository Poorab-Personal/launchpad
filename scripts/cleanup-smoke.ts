/**
 * One-shot cleanup of the smoke-test backfill:
 *   1. Archive HS Tickets I created (pipeline=0, subject ends "- LP", created today)
 *   2. Clear Stripe metadata I added (3 keys → empty string = delete)
 *   3. Revert orphan signals (UPDATE customer_usage_signals SET customer_id=NULL)
 *   4. DELETE FROM customers WHERE created_via='backfill' (cascades)
 *
 * Dry-run by default; --apply to execute.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { Client } from '@hubspot/api-client';
import Stripe from 'stripe';
import ws from 'ws';

const APPLY = process.argv.includes('--apply');
neonConfig.webSocketConstructor = ws;

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const pool = new Pool({ connectionString: process.env.POSTGRES_URL_NON_POOLING });
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN! });
  const stripeKey = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('Stripe key missing');
  const stripe = new Stripe(stripeKey);

  // ── Step 1: find the 10 backfilled customers ─────────────────────────────
  const customers = (
    await pool.query(`
      SELECT id, contact_email, hubspot_contact_id, hubspot_ticket_id,
             stripe_customer_id, stripe_subscription_id, rejig_user_id
      FROM customers
      WHERE created_via='backfill'
    `)
  ).rows;
  console.log(`Backfilled customers found: ${customers.length}\n`);

  // ── Step 2: enumerate HS Tickets to archive ──────────────────────────────
  // For each customer's HS Contact, fetch associated CJ tickets, filter to
  // those I created (subject ends "- LP" + created today/yesterday).
  const allMyTicketIds = new Set<string>();
  for (const c of customers) {
    if (c.hubspot_ticket_id) allMyTicketIds.add(c.hubspot_ticket_id);
    if (!c.hubspot_contact_id) continue;
    try {
      const assocs = await hs.crm.associations.v4.basicApi.getPage('contacts', c.hubspot_contact_id, 'tickets');
      const ticketIds = assocs.results.map((r: { toObjectId: number | string }) => String(r.toObjectId));
      if (ticketIds.length === 0) continue;
      const tickets = await hs.crm.tickets.batchApi.read({
        inputs: ticketIds.map((id) => ({ id })),
        properties: ['subject', 'createdate', 'hs_pipeline'],
        propertiesWithHistory: [],
      });
      for (const t of tickets.results) {
        const subject = t.properties?.subject ?? '';
        const created = t.properties?.createdate ?? '';
        const pipeline = t.properties?.hs_pipeline ?? '';
        if (pipeline === '0' && subject.endsWith('- LP') && created.slice(0, 10) >= '2026-05-15') {
          allMyTicketIds.add(t.id);
        }
      }
    } catch (err) {
      console.warn(`HS lookup failed for contact ${c.hubspot_contact_id}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`HS Tickets to archive: ${allMyTicketIds.size}`);

  // ── Step 3: Stripe metadata to clear (per unique sub_id + cus_id pair) ──
  const stripeCusIds = new Set<string>();
  const stripeSubIds = new Set<string>();
  for (const c of customers) {
    if (c.stripe_customer_id) stripeCusIds.add(c.stripe_customer_id);
    if (c.stripe_subscription_id) stripeSubIds.add(c.stripe_subscription_id);
  }
  console.log(`Stripe Customers to clear metadata on: ${stripeCusIds.size}`);
  console.log(`Stripe Subscriptions to clear metadata on: ${stripeSubIds.size}`);

  if (!APPLY) {
    console.log('\n— DRY-RUN — no writes performed. Re-run with --apply.');
    await pool.end();
    process.exit(0);
  }

  // ── EXECUTE ───────────────────────────────────────────────────────────────
  console.log('\nExecuting cleanup…');

  // Archive HS Tickets
  let archived = 0;
  for (const id of allMyTicketIds) {
    try {
      await hs.crm.tickets.basicApi.archive(id);
      archived++;
    } catch (err) {
      console.warn(`  archive ${id} failed:`, err instanceof Error ? err.message.slice(0, 100) : err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`  Archived ${archived}/${allMyTicketIds.size} tickets`);

  // Clear Stripe metadata (Stripe interprets '' as delete the key)
  let stripeCleared = 0;
  for (const cusId of stripeCusIds) {
    try {
      await stripe.customers.update(cusId, {
        metadata: { launchpad_customer_id: '', rejig_user_id: '', hubspot_contact_id: '' },
      });
      stripeCleared++;
    } catch (err) {
      console.warn(`  Stripe customer ${cusId}:`, err instanceof Error ? err.message.slice(0, 80) : err);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  let stripeSubsCleared = 0;
  for (const subId of stripeSubIds) {
    try {
      await stripe.subscriptions.update(subId, {
        metadata: { launchpad_customer_id: '', rejig_user_id: '', hubspot_contact_id: '' },
      });
      stripeSubsCleared++;
    } catch (err) {
      console.warn(`  Stripe sub ${subId}:`, err instanceof Error ? err.message.slice(0, 80) : err);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`  Cleared Stripe: ${stripeCleared} customers, ${stripeSubsCleared} subs`);

  // Revert orphan signals + delete LP customers
  const sigRevert = await pool.query(`
    UPDATE customer_usage_signals SET customer_id=NULL
    WHERE customer_id IN (SELECT id FROM customers WHERE created_via='backfill')
    RETURNING id
  `);
  const customerDel = await pool.query(`DELETE FROM customers WHERE created_via='backfill' RETURNING id`);
  console.log(`  Reverted ${sigRevert.rowCount} signals to orphan`);
  console.log(`  Deleted ${customerDel.rowCount} LP customers`);

  const remaining = await pool.query(`SELECT COUNT(*) as n FROM customers`);
  console.log(`\nRemaining customers in LP: ${remaining.rows[0].n}`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
