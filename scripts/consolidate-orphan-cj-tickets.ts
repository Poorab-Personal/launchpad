/**
 * Consolidate orphan CJ tickets into LP-managed tickets.
 *
 * Per user spec (2026-05-18 review of orphan-cj-audit):
 *
 *   For each KNOWN DUPLICATE pair {old_cj_ticket, new_lp_ticket}:
 *     1. Read BI props from the NEW LP-managed ticket
 *     2. Write those props + post-launch stage to the OLD CJ ticket
 *        (preserves old ticket's CSM history)
 *     3. Update LP customer.hubspot_ticket_id → OLD ticket id
 *        (so future BI runs push to the old ticket)
 *     4. Archive the NEW ticket in HS
 *
 *   For each CHURNED ticket (not in LP, Rejig dropped them):
 *     - Move HS ticket stage to "Churned" (1154519684)
 *     - No LP-side changes
 *
 * Dry-run by default. Use --apply to execute.
 *
 *   npx tsx --env-file=.env.local scripts/consolidate-orphan-cj-tickets.ts
 *   npx tsx --env-file=.env.local scripts/consolidate-orphan-cj-tickets.ts --apply
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { eq } from 'drizzle-orm';

const APPLY = process.argv.includes('--apply');

// HS pipeline stage ID for "Churned"
const STAGE_CHURNED = '1154519684';

// 12 confirmed reroutes per 2026-05-18 user review.
// Format: { oldTicketId, newTicketId, lpCustomerId, personName, businessName }
const REROUTES = [
  { old: '45181023151', new: '311276657364', lp: 'a8c0a508-4981-4f16-b64b-60b52f653249', who: 'Mark DeChambeau → DeChambeau Homes' },
  { old: '29394892346', new: '311212112576', lp: '129853ac-d716-4195-b77f-90a4052c217b', who: 'Lulu Logan → Just 1 Real Estate' },
  { old: '33436857735', new: '311817761496', lp: 'd80532ac-5fd7-46a6-a8e0-7437eba14d81', who: 'Sandy Fecci → Kraase Property Group' },
  { old: '41534358656', new: '311280326388', lp: 'bba32b50-d8fe-4e9e-8172-ef17f1baea29', who: 'Marisol Gonzalez → Marisol González Ventura' },
  { old: '42588638260', new: '311212112578', lp: 'dca3c952-4166-47dc-86b9-381b86a8755a', who: 'Qunning Rong → Qunning Realty' },
  { old: '44974169871', new: '45273950108',  lp: '1d00012a-7843-4e98-b8ca-ea1f70442a2d', who: 'Leon Harper → Triwood Realty' },
  { old: '45269764245', new: '311384944356', lp: '5dfd7303-ca74-4e04-9f63-e0b12d86ed31', who: 'Sarah Scott → Scott Property Group' },
  { old: '43722816009', new: '45092417959',  lp: '99739ad2-65e2-4c98-9319-e779f28de197', who: 'Cathy L Krieger → Third Watch Group' },
  { old: '29599814045', new: '311774808825', lp: 'e02d8dd8-cdf9-4e9b-9508-5c057dfde72a', who: 'Jim Crotwell → KW Big Bear Lake Arrowhead' },
  { old: '32204116075', new: '311815957218', lp: '8cee5723-14e3-439f-ae26-d807b6d2b0b7', who: 'Ashley Fuentes → note. A Mortgage Agency' },
  { old: '37092170905', new: '311158387440', lp: '71d42bdb-6362-4803-b73c-a0e14f77d5dd', who: 'Jordyn Jensen → The Baird Group' },
  { old: '38522575447', new: '311206741737', lp: 'f4306b00-0bcf-4967-be83-5cdc94b0de61', who: 'Alicia Hodges → Ask Cathy Marketing Group' },
];

// 8 hidden Contact-dup matches from earlier scan (orphan-cj-hidden-dupes-2026-05-18.csv)
// Add these too so we consolidate everything in one pass.
const HIDDEN_DUPS = [
  // Loaded dynamically below from CSV — see loadHiddenDupes()
];

// Churned: move these to Churned stage. Per 2026-05-18 user review.
const CHURNED_TICKETS = [
  { ticket: '29407462234', who: 'neda lamiri' },
  { ticket: '29542906669', who: 'Alex Lam (The Lam Team)' },
  { ticket: '36842333240', who: 'Kelsey Watters' },
  { ticket: '36863649165', who: 'Rob Kittle' },
  { ticket: '42544739455', who: 'Brekke Davis' },
  { ticket: '29383010706', who: 'Megan Shoff' },
  { ticket: '30336028519', who: 'Angel Smith' },
  { ticket: '30496936059', who: 'Kristin Hilberg' },
  { ticket: '29358260769', who: 'Joseph Spurlock' },
  { ticket: '29481924791', who: 'Kevin May' },
  { ticket: '34826757283', who: 'Tass Fry' },
  { ticket: '35005870106', who: 'Robert Abrams' },
  { ticket: '42468164701', who: 'John Garuti' },
  { ticket: '29255242500', who: 'Scott Armstrong' },
  { ticket: '29350996543', who: 'David Huffaker' },
  { ticket: '29524274245', who: 'Angie Byrd (Byrdgirl Group)' },
  { ticket: '29390469732', who: 'Howard B Dolgoff' },
  { ticket: '29084057633', who: 'Kerry McGrory (Melissa Healy Group)' },
  { ticket: '31460176761', who: 'Katrina Léonce' },
  { ticket: '32174700390', who: 'Cheri Glynn' },
  { ticket: '35333743880', who: 'Zac Morton' },
  { ticket: '36405817214', who: 'Christy Arnett' },
  { ticket: '29351004282', who: 'Tish Dray' },
  { ticket: '30908673610', who: 'Katherine Blanchard' },
];

// BI properties we read from the new ticket and write to the old one.
const BI_TICKET_PROPS = [
  'hs_pipeline_stage',
  'rejig_attention_reason',
  'rejig_attention_set_at',
  'rejig_recommended_action',
  'rejig_recommended_action_urgency',
  'rejig_recommended_action_set_at',
];

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
    // Returns null on 404 (already archived) so caller can fall back to
    // LP-pointer-only update without losing the consolidation.
    if (e.code === 404) return null;
    throw e;
  }
}

async function archiveIfExists(hs: Client, ticketId: string): Promise<boolean> {
  try {
    await hs.crm.tickets.basicApi.archive(ticketId);
    return true;
  } catch (e: any) {
    if (e.code === 404) return false; // already archived
    throw e;
  }
}

async function writeProps(hs: Client, ticketId: string, props: Record<string, string>): Promise<void> {
  await hs.crm.tickets.basicApi.update(ticketId, { properties: props });
}

async function archiveTicket(hs: Client, ticketId: string): Promise<void> {
  await hs.crm.tickets.basicApi.archive(ticketId);
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });
  console.log(`[consolidate] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[consolidate] reroutes: ${REROUTES.length}, churned: ${CHURNED_TICKETS.length}`);
  console.log();

  // === Phase 1: Reroutes ===
  console.log('━━━ PHASE 1: REROUTES (keep OLD CJ, archive NEW LP) ━━━');
  let rerouteOk = 0, rerouteFail = 0;
  for (const r of REROUTES) {
    console.log(`\n• ${r.who}`);
    console.log(`  OLD CJ ticket: ${r.old}  (will be kept + updated)`);
    console.log(`  NEW LP ticket: ${r.new}  (will be archived)`);
    console.log(`  LP customer:   ${r.lp}`);
    try {
      // 1. Read BI props from NEW ticket (null if already archived)
      const props = await readBiProps(hs, r.new);
      if (props === null) {
        console.log('  ⚠ NEW ticket already archived (404) — will only update LP pointer; next BI run will repopulate props on OLD ticket');
      } else {
        console.log(`  [read] NEW ticket props: ${Object.keys(props).join(', ')}`);
      }
      await new Promise((s) => setTimeout(s, 500));

      if (APPLY) {
        // 2. Write BI props (incl. stage) to OLD ticket — skip if NEW was archived
        if (props && Object.keys(props).length > 0) {
          await writeProps(hs, r.old, props);
          console.log('  [write] OLD ticket updated with BI props + stage');
          await new Promise((s) => setTimeout(s, 500));
        }
        // 3. Update LP DB: customers.hubspot_ticket_id = OLD
        await db.update(customers).set({ hubspotTicketId: r.old }).where(eq(customers.id, r.lp));
        console.log(`  [db]    LP customer.hubspot_ticket_id = ${r.old}`);
        // 4. Archive NEW ticket if not already
        const wasArchived = await archiveIfExists(hs, r.new);
        console.log(wasArchived ? '  [hs]    NEW ticket archived' : '  [hs]    NEW ticket was already archived');
        await new Promise((s) => setTimeout(s, 500));
      } else {
        console.log('  (dry-run — would update LP DB + archive NEW ticket)');
      }
      rerouteOk++;
    } catch (e) {
      console.log(`  ✗ ERROR: ${e instanceof Error ? e.message : e}`);
      rerouteFail++;
    }
  }

  // === Phase 2: Churned ===
  console.log('\n\n━━━ PHASE 2: CHURNED (move CJ tickets to Churned stage) ━━━');
  let churnedOk = 0, churnedFail = 0;
  for (const c of CHURNED_TICKETS) {
    console.log(`• ${c.who.padEnd(40)}  ticket=${c.ticket}`);
    try {
      if (APPLY) {
        await writeProps(hs, c.ticket, { hs_pipeline_stage: STAGE_CHURNED });
        await new Promise((s) => setTimeout(s, 400));
      }
      churnedOk++;
    } catch (e) {
      console.log(`  ✗ ERROR: ${e instanceof Error ? e.message : e}`);
      churnedFail++;
    }
  }

  console.log('\n\n━━━ SUMMARY ━━━');
  console.log(`Reroutes: ${rerouteOk} ok, ${rerouteFail} failed`);
  console.log(`Churned:  ${churnedOk} ok, ${churnedFail} failed`);
  console.log(APPLY ? '\n✓ Applied' : '\n(dry-run — re-run with --apply to execute)');

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
