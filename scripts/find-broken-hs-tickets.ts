/**
 * Scan LP customers for ones whose hubspot_ticket_id returns 404 in HS.
 * Likely caused by yesterday's archive-heavy cleanup where some LP rows
 * still point to archived tickets.
 */
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { isNotNull } from 'drizzle-orm';
import { Client } from '@hubspot/api-client';

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });
  const all = await db.query.customers.findMany({ where: isNotNull(customers.hubspotTicketId) });
  console.log(`[scan] Checking ${all.length} LP customers' hubspot_ticket_ids…`);

  type Broken = { id: string; name: string; ticketId: string; contactId: string | null };
  const broken: Broken[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    try {
      await hs.crm.tickets.basicApi.getById(c.hubspotTicketId!, ['hs_pipeline_stage']);
    } catch (e: any) {
      if (e.code === 404) broken.push({ id: c.id, name: c.name ?? '', ticketId: c.hubspotTicketId!, contactId: c.hubspotContactId });
    }
    if ((i + 1) % 50 === 0) process.stdout.write(`\r[scan] ${i + 1}/${all.length} | broken so far: ${broken.length}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stdout.write('\n');
  console.log(`\n=== ${broken.length} broken HS ticket pointers ===`);
  for (const b of broken.slice(0, 30)) {
    console.log(`  ${b.id} | ${b.name.padEnd(40)} | ticket=${b.ticketId} | contact=${b.contactId}`);
  }
  if (broken.length > 30) console.log(`  ... and ${broken.length - 30} more`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
