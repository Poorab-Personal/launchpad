/**
 * Verify the 13 user-identified LP customer matches from the my_notes
 * column of "UPDATED - orphan-cj-audit-2026-05-18.csv".
 *
 * For each {orphan ticket → user's business-name guess}:
 *   1. Search LP customers for that business name (fuzzy)
 *   2. Report the LP customer's id, name, current hubspot_ticket_id
 *      (the NEW "- LP" ticket we created during backfill), state, etc.
 *   3. Flag any with multiple LP matches (ambiguous) or zero matches
 *
 * Also: special handling for Cathy Krieger — user noted there are TWO HS
 * tickets (one with middle initial, one without). Verify by HS search.
 *
 *   npx tsx --env-file=.env.local scripts/verify-lp-matches-from-notes.ts
 */
import { Client } from '@hubspot/api-client';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';

// Map: { orphan_ticket_id, person_name, user_business_name }
const USER_MATCHES = [
  { orphan_ticket_id: '45181023151', person: 'Mark DeChambeau', business: 'DeChambeau Homes' },
  { orphan_ticket_id: '29394892346', person: 'Lulu Logan', business: 'Just 1 Real Estate' },
  { orphan_ticket_id: '33436857735', person: 'Sandy Fecci', business: 'Kraase Property Group' },
  { orphan_ticket_id: '41534358656', person: 'Marisol Gonzalez', business: 'Marisol González Ventura' },
  { orphan_ticket_id: '42588638260', person: 'Qunning Rong', business: 'Qunning Realty' },
  { orphan_ticket_id: '44974169871', person: 'Leon Harper', business: 'TriWood Realty' },
  { orphan_ticket_id: '45269764245', person: 'Sarah Scott', business: 'Scott Property Group' },
  { orphan_ticket_id: '43722816009', person: 'Cathy L Krieger', business: 'Cathy Krieger' },
  { orphan_ticket_id: '29599814045', person: 'Jim Crotwell', business: 'Keller Williams Big Bear Lake Arrowhead' },
  { orphan_ticket_id: '32204116075', person: 'Ashley Fuentes', business: 'note. A Mortgage Agency' },
  { orphan_ticket_id: '34713339173', person: 'Lisa Forss', business: 'Team Forss' },
  { orphan_ticket_id: '37092170905', person: 'Jordyn Jensen', business: 'The Baird Group with LPT Realty' },
  { orphan_ticket_id: '38522575447', person: 'Alicia Hodges', business: 'Ask Cathy Marketing Group' },
];

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[\s,.\-_/]+/).filter((t) => t.length > 2);
}

async function main() {
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN });
  const allLp = await db.query.customers.findMany();

  console.log(`LP customers loaded: ${allLp.length}\n`);
  console.log('=== Per-row verification ===\n');

  let resolved = 0, ambiguous = 0, missing = 0;

  for (const m of USER_MATCHES) {
    const businessTokens = tokens(m.business);
    // Score each LP customer: how many of the business tokens appear in
    // either LP.name or LP.businessName (case-insensitive)
    const scored = allLp.map((c) => {
      const hay = `${(c.name || '').toLowerCase()} ${(c.businessName || '').toLowerCase()}`;
      const hits = businessTokens.filter((t) => hay.includes(t)).length;
      return { c, hits };
    }).filter((x) => x.hits >= Math.max(1, Math.ceil(businessTokens.length * 0.6)))
      .sort((a, b) => b.hits - a.hits);

    console.log(`Orphan ticket: ${m.orphan_ticket_id}  Person: "${m.person}"  User said: "${m.business}"`);
    if (scored.length === 0) {
      console.log('  ✗ NO LP match found\n');
      missing++;
      continue;
    }
    // Show top candidate(s)
    const top = scored.slice(0, 3);
    const exactBest = top[0];
    if (top.length === 1 || (top[0].hits > top[1].hits)) {
      console.log(`  ✓ LP customer: ${exactBest.c.name}`);
      console.log(`    LP id: ${exactBest.c.id}`);
      console.log(`    LP-managed ticket (new "- LP"): ${exactBest.c.hubspotTicketId}`);
      console.log(`    LP HS contact: ${exactBest.c.hubspotContactId}`);
      console.log(`    State: ${exactBest.c.onboardingState} | Sub: ${exactBest.c.subscriptionStatus}`);
      console.log(`    Email: ${exactBest.c.contactEmail}`);
      console.log(`    rejig_user_id: ${exactBest.c.rejigUserId}`);
      console.log();
      resolved++;
    } else {
      console.log(`  ? AMBIGUOUS — ${top.length} candidates with same score (${top[0].hits} token hits):`);
      for (const x of top) console.log(`    - ${x.c.name} (lp_ticket=${x.c.hubspotTicketId})`);
      console.log();
      ambiguous++;
    }
  }

  console.log('\n=== Cathy Krieger HS deep-dive ===');
  // User said: 2 HS tickets exist for Cathy. Rejig customer is just "Cathy Krieger"
  // The orphan ticket in audit is 43722816009 ("Cathy L Krieger (B&W) - CJ")
  // Find ALL HS tickets whose subject contains "Krieger"
  const ticketSearch = await hs.crm.tickets.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'subject', operator: 'CONTAINS_TOKEN', value: 'Krieger' } as any] }],
    properties: ['subject', 'hs_pipeline_stage', 'createdate', 'hs_lastmodifieddate'],
    limit: 20,
  } as any);
  console.log(`HS tickets with "Krieger" in subject: ${ticketSearch.results.length}`);
  for (const t of ticketSearch.results) {
    console.log(`  ${t.id} | stage=${t.properties.hs_pipeline_stage} | subj="${(t.properties.subject as string)?.slice(0,50)}"`);
  }

  console.log('\n=== Summary ===');
  console.log(`Verified (1 LP match): ${resolved}`);
  console.log(`Ambiguous (need disambig): ${ambiguous}`);
  console.log(`Missing (no LP match): ${missing}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
