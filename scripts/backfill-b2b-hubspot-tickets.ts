/**
 * Phase 1.5.5.S4 — backfill HubSpot Contacts + Tickets for B2B customers
 * that exist in LP but have no hubspotTicketId (created via admin Add
 * Customer before the LP→HS B2B push was wired).
 *
 * Idempotent: skips customers that already have a ticket. Re-runnable.
 *
 * Usage:
 *   # Dry-run (default — lists what would be pushed):
 *   npx tsx scripts/backfill-b2b-hubspot-tickets.ts
 *
 *   # Apply:
 *   npx tsx scripts/backfill-b2b-hubspot-tickets.ts --apply
 *
 *   # Limit to specific customers:
 *   npx tsx scripts/backfill-b2b-hubspot-tickets.ts --apply --customer-id=<uuid>
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    customerIds: args.filter((a) => a.startsWith('--customer-id=')).map((a) => a.replace('--customer-id=', '').trim()),
  };
}

async function main() {
  const { apply, customerIds } = parseArgs();

  const { db } = await import('../src/db');
  const { customers } = await import('../src/db/schema/customers');
  const { and, eq, inArray, isNull } = await import('drizzle-orm');

  console.log(`\n${'='.repeat(72)}`);
  console.log(`B2B HubSpot ticket backfill — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`${'='.repeat(72)}\n`);

  const candidates = await db
    .select({
      id: customers.id,
      name: customers.name,
      workflowKey: customers.workflowKey,
      contactEmail: customers.contactEmail,
      currentStage: customers.currentStage,
    })
    .from(customers)
    .where(
      and(
        eq(customers.type, 'B2B'),
        isNull(customers.hubspotTicketId),
        customerIds.length > 0 ? inArray(customers.id, customerIds) : undefined,
      ),
    );

  if (candidates.length === 0) {
    console.log('No B2B customers without hubspotTicketId. Nothing to backfill.\n');
    return;
  }

  console.log(`Found ${candidates.length} B2B customer(s) without a HubSpot Ticket:\n`);
  for (const c of candidates) {
    console.log(`  - ${c.name}  (${c.id})  [${c.workflowKey}, stage=${c.currentStage}]  email=${c.contactEmail}`);
  }
  console.log();

  if (!apply) {
    console.log('DRY RUN complete. Re-run with --apply to push these to HubSpot.\n');
    return;
  }

  console.log('APPLYING...\n');

  const { pushCustomerIntakeToHubSpot } = await import('../src/lib/integrations/hubspot/intake-handler');

  for (const c of candidates) {
    process.stdout.write(`  ${c.name.padEnd(30)} `);
    try {
      const result = await pushCustomerIntakeToHubSpot(c.id);
      if (result.kind === 'pushed') {
        console.log(`✅ contact=${result.contactId} (new=${result.contactWasNew}) ticket=${result.ticketId}`);
      } else if (result.kind === 'skipped') {
        console.log(`⏭️  skipped: ${result.reason}`);
      } else {
        console.log(`❌ ${result.error}`);
      }
    } catch (err) {
      console.log(`❌ threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDone.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
