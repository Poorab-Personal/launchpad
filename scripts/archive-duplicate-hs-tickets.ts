/**
 * Archive the duplicate HubSpot Customer Journey tickets created by the
 * intake-push self-collision (see migration 0026 and
 * docs/integrations/hubspot-intake-push-collision.md).
 *
 * Each affected customer has TWO live tickets, both associated to the same
 * Contact. LP only knows about one (`customers.hubspot_ticket_id`) — and the
 * inbound HS webhook resolves customers by that column, so any stage move a
 * CSM makes on the other ticket is invisible to LaunchPad. Because both
 * tickets hang off the same Contact, HubSpot's own workflows enroll both, so
 * the orphan drifts along looking plausible in the pipeline.
 *
 *   npx tsx scripts/archive-duplicate-hs-tickets.ts            # dry run
 *   npx tsx scripts/archive-duplicate-hs-tickets.ts --confirm  # archive
 *
 * Two pre-flight guards, both hard refusals:
 *
 *   1. The candidate must not be any customer's `hubspot_ticket_id`.
 *      Archiving the one LP points at would sever the customer from HubSpot.
 *   2. The keeper must already hold every meeting associated to the candidate.
 *      Meetings are how CSMs reach a ticket and where the onboarding outcome
 *      is recorded, so archiving a ticket carrying a meeting the keeper lacks
 *      would hide that meeting from the surviving ticket. (The meeting object
 *      itself survives on the Contact — but ticket-level visibility is the
 *      whole point.) Re-associate it to the keeper first, then re-run.
 *
 * HubSpot archive is a soft delete — restorable from the recycling bin for
 * 90 days.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// [customer name, ticket to archive, ticket LP points at]
const CANDIDATES: Array<[string, string, string]> = [
  ['Mary Sibiski',      '317247915764', '317267214065'],
  ['Amos Eyal, P.A.',   '319884316356', '319845081817'],
  ['JoAnn Mazzeo',      '321507180279', '321458730708'],
  ['Tim Webb',          '321891807955', '321758185197'],
  ['CJ Wang',           '325599600327', '325587454712'],
  ['Bhavik Patel',      '325475179245', '325538633434'],
  ['Monica Hanna',      '326907365110', '326727372493'],
  ['Roberto Cavaliere', '328048153311', '328082603739'],
  ['Kristi Dye',        '329066783430', '329064985312'],
  ['Jennifer Boyce',    '335039642350', '335006752472'],
];

async function main() {
  const confirm = process.argv.includes('--confirm');
  const token = process.env.HUBSPOT_STATIC_TOKEN;
  if (!token) throw new Error('HUBSPOT_STATIC_TOKEN not set');

  const { Client } = await import('@hubspot/api-client');
  const { db } = await import('../src/db');
  const { sql } = await import('drizzle-orm');
  const hs = new Client({ accessToken: token });

  // One pull of every ticket id LP considers authoritative.
  const live = await db.execute(sql`
    SELECT hubspot_ticket_id FROM customers WHERE hubspot_ticket_id IS NOT NULL
  `);
  const lpTicketIds = new Set(
    (live.rows as Array<{ hubspot_ticket_id: string }>).map((r) => r.hubspot_ticket_id),
  );

  const meetingIdsFor = async (ticketId: string): Promise<string[]> => {
    const t = await hs.crm.tickets.basicApi.getById(ticketId, ['subject'], undefined, ['meetings']);
    return (t.associations?.meetings?.results ?? []).map((r) => r.id);
  };

  console.log(confirm ? 'ARCHIVING duplicate tickets\n' : 'DRY RUN — pass --confirm to archive\n');

  for (const [name, orphanId, keepId] of CANDIDATES) {
    if (lpTicketIds.has(orphanId)) {
      console.log(`✗ ${name}: REFUSING — LP points at ${orphanId}. Investigate by hand.`);
      continue;
    }
    if (!lpTicketIds.has(keepId)) {
      console.log(`✗ ${name}: REFUSING — LP does not point at the keeper ${keepId} either.`);
      continue;
    }

    // Guard 2 — never archive a ticket holding a meeting the keeper lacks.
    const [orphanMeetings, keepMeetings] = await Promise.all([
      meetingIdsFor(orphanId),
      meetingIdsFor(keepId),
    ]);
    const strandedMeetings = orphanMeetings.filter((m) => !keepMeetings.includes(m));
    if (strandedMeetings.length > 0) {
      console.log(
        `✗ ${name}: REFUSING — meeting(s) ${strandedMeetings.join(', ')} are on ${orphanId} `
        + `but NOT on the keeper ${keepId}. Associate them to ${keepId} first `
        + `(ensureMeetingTicketAssociation), then re-run.`,
      );
      continue;
    }

    const meetingNote = `${orphanMeetings.length} meeting(s) on orphan, all present on keeper`;
    if (!confirm) {
      console.log(`· ${name}: would archive ${orphanId} (keeping ${keepId}) — ${meetingNote}`);
      continue;
    }
    try {
      await hs.crm.tickets.basicApi.archive(orphanId);
      console.log(`✓ ${name}: archived ${orphanId} (keeping ${keepId})`);
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      if (e.code === 404) console.log(`· ${name}: ${orphanId} already gone (404)`);
      else console.warn(`✗ ${name}: archive failed for ${orphanId}: ${e.message ?? String(err)}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
