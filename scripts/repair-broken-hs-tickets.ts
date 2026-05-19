/**
 * Repair 3 LP customers whose hubspot_ticket_id pointers are 404'd.
 *
 *   Chicago Apt Condo Team → Contact has a LIVE ticket; just re-link.
 *   Amy Berman             → Contact has NO tickets; create fresh in HS.
 *   Anthony Scalzo PA      → Contact has NO tickets; create fresh in HS.
 *
 * For the create cases: build a fresh CJ ticket in the customer's current
 * post-launch stage (Active/Watch/etc.) with subject "{name} - LP" and
 * the standard Contact association.
 *
 *   npx tsx --env-file=.env.local scripts/repair-broken-hs-tickets.ts        # dry-run
 *   npx tsx --env-file=.env.local scripts/repair-broken-hs-tickets.ts --apply
 */
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { eq } from 'drizzle-orm';
import { createCustomerJourneyTicket } from '@/lib/integrations/hubspot/client';

const APPLY = process.argv.includes('--apply');

type Repair = {
  lpId: string;
  action: 'relink' | 'create';
  // For relink:
  newTicketId?: string;
  // For create:
  // (derives subject + stage from LP record)
};

const REPAIRS: Repair[] = [
  // Chicago Apt Condo Team: contact 212827899981 already has live ticket 311542505156
  { lpId: '9545a8c8-4b45-4bbd-9ad1-fe3856c36186', action: 'relink', newTicketId: '311542505156' },
  // Amy Berman: no tickets → create
  { lpId: 'f856e9d5-20ad-4ab3-b8b5-43747df8f561', action: 'create' },
  // Anthony Scalzo PA: no tickets → create
  { lpId: 'dcf85097-2ef7-4c75-97a0-4ea4f999b3ec', action: 'create' },
];

async function main() {
  console.log(`[repair] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  for (const r of REPAIRS) {
    const lp = await db.query.customers.findFirst({ where: eq(customers.id, r.lpId) });
    if (!lp) {
      console.log(`\n  ✗ LP customer not found: ${r.lpId}`);
      continue;
    }
    console.log(`\n• ${lp.name}  (action=${r.action})`);
    console.log(`  old ticket: ${lp.hubspotTicketId} (404'd)`);
    console.log(`  contact:    ${lp.hubspotContactId}`);
    console.log(`  state:      ${lp.onboardingState}`);

    if (r.action === 'relink' && r.newTicketId) {
      if (APPLY) {
        await db.update(customers).set({ hubspotTicketId: r.newTicketId }).where(eq(customers.id, r.lpId));
        console.log(`  [db] LP customer.hubspotTicketId = ${r.newTicketId}`);
      } else {
        console.log(`  (dry-run) would set LP.hubspotTicketId = ${r.newTicketId}`);
      }
    } else if (r.action === 'create') {
      if (!lp.hubspotContactId) {
        console.log('  ✗ No HS contact ID — cannot create ticket. Skipping.');
        continue;
      }
      const stageLabel = lp.onboardingState === 'At-Risk' ? 'At Risk' : (lp.onboardingState ?? 'Active');
      const subject = `${lp.name} - LP`;
      if (APPLY) {
        const result = await createCustomerJourneyTicket({
          subject,
          stageLabel,
          contactId: lp.hubspotContactId,
          customProperties: {
            rejig_attention_reason: lp.attentionReason ?? '',
            rejig_attention_set_at: lp.attentionSetAt?.toISOString() ?? '',
          },
        });
        await db.update(customers).set({ hubspotTicketId: result.ticketId }).where(eq(customers.id, r.lpId));
        console.log(`  [hs] created ticket ${result.ticketId} in stage "${stageLabel}"`);
        console.log(`  [db] LP customer.hubspotTicketId = ${result.ticketId}`);
      } else {
        console.log(`  (dry-run) would create CJ ticket: subject="${subject}", stage="${stageLabel}"`);
      }
    }
  }
  console.log(APPLY ? '\n✓ Applied' : '\n(dry-run — re-run with --apply to execute)');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
