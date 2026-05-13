/**
 * HubSpot integration PoC.
 *
 * Validates that LaunchPad can perform the load-bearing push operations against
 * the real Rejig HubSpot account using a Developer Platform static auth token.
 *
 * Run: npm run hubspot:poc
 *
 * Operations tested, in order:
 *   1. Auth check — read the test ticket
 *   2. Move pipeline stage (and revert)
 *   3. Update health_status custom property (and revert)
 *   4. Create a Note attached to the test ticket
 *   5. Create a brand new test ticket in Intake Pending
 *   6. Verify final state
 *
 * If all steps succeed, the integration architecture is feasible.
 */

import { Client } from '@hubspot/api-client';

const TEST_TICKET_ID = '44607710477';
const PORTAL_ID = '44956899';
const PIPELINE_ID = '0'; // Customer Journey Stages

// Pipeline stage IDs (from earlier MCP audit)
const STAGE_INTAKE_PENDING = '1154519671';
const STAGE_ONBOARDING_BOOKED = '1154519674';
const STAGE_ONBOARDED_PARTIALLY = '1165504776';

// Association type ID for Note → Ticket (HubSpot standard)
const ASSOC_NOTE_TO_TICKET = 228;

function ticketUrl(id: string) {
  return `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-5/${id}`;
}

async function main() {
  const token = process.env.HUBSPOT_STATIC_TOKEN;
  if (!token) {
    throw new Error('HUBSPOT_STATIC_TOKEN not set in env. Add it to .env.local.');
  }

  const hubspot = new Client({ accessToken: token });

  console.log('═══ HubSpot Integration PoC ═══\n');

  // ── Step 1: Auth check — read the test ticket ─────────────────────────────
  console.log('[1/6] Reading test ticket', TEST_TICKET_ID, '...');
  const initial = await hubspot.crm.tickets.basicApi.getById(TEST_TICKET_ID, [
    'subject',
    'hs_pipeline_stage',
    'health_status',
    'hubspot_owner_id',
    'createdate',
  ]);
  console.log('      Subject:        ', initial.properties.subject);
  console.log('      Pipeline stage: ', initial.properties.hs_pipeline_stage);
  console.log('      Health status:  ', initial.properties.health_status ?? '(unset)');
  console.log('      Owner:          ', initial.properties.hubspot_owner_id);
  console.log('   ✓ Auth + read works\n');

  const originalStage = initial.properties.hs_pipeline_stage!;
  const originalHealth = initial.properties.health_status;

  // ── Step 2: Move pipeline stage (and revert) ──────────────────────────────
  // Pick a "safe" temp stage different from the current one.
  const tempStage =
    originalStage === STAGE_ONBOARDED_PARTIALLY
      ? STAGE_ONBOARDING_BOOKED
      : STAGE_ONBOARDED_PARTIALLY;

  console.log('[2/6] Moving stage', originalStage, '→', tempStage, '...');
  await hubspot.crm.tickets.basicApi.update(TEST_TICKET_ID, {
    properties: { hs_pipeline_stage: tempStage },
  });
  const afterMove = await hubspot.crm.tickets.basicApi.getById(TEST_TICKET_ID, [
    'hs_pipeline_stage',
  ]);
  console.log('      Stage now:', afterMove.properties.hs_pipeline_stage);

  console.log('      Reverting to', originalStage, '...');
  await hubspot.crm.tickets.basicApi.update(TEST_TICKET_ID, {
    properties: { hs_pipeline_stage: originalStage },
  });
  console.log('   ✓ Stage update + revert works\n');

  // ── Step 3: Update health_status ──────────────────────────────────────────
  const tempHealth =
    originalHealth === 'Needs more touches' ? 'Active - Healthy' : 'Needs more touches';

  console.log('[3/6] Setting health_status →', tempHealth, '...');
  await hubspot.crm.tickets.basicApi.update(TEST_TICKET_ID, {
    properties: { health_status: tempHealth },
  });
  const afterHealth = await hubspot.crm.tickets.basicApi.getById(TEST_TICKET_ID, [
    'health_status',
  ]);
  console.log('      Health now:', afterHealth.properties.health_status);

  if (originalHealth) {
    await hubspot.crm.tickets.basicApi.update(TEST_TICKET_ID, {
      properties: { health_status: originalHealth },
    });
    console.log('      Reverted to', originalHealth);
  } else {
    console.log('      (Original was unset; leaving at', tempHealth + '. Clean up manually if desired.)');
  }
  console.log('   ✓ Custom property update works\n');

  // ── Step 4: Create a Note attached to the test ticket ─────────────────────
  console.log('[4/6] Creating a Note attached to the test ticket...');
  const note = await hubspot.crm.objects.notes.basicApi.create({
    properties: {
      hs_note_body: `[LaunchPad PoC] Test note created ${new Date().toISOString()}. Safe to delete.`,
      hs_timestamp: Date.now().toString(),
    },
    associations: [
      {
        to: { id: TEST_TICKET_ID },
        types: [
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            associationCategory: 'HUBSPOT_DEFINED' as any,
            associationTypeId: ASSOC_NOTE_TO_TICKET,
          },
        ],
      },
    ],
  });
  console.log('      Note ID:', note.id);
  console.log('   ✓ Note creation + association works\n');

  // ── Step 5: Create a new test ticket ──────────────────────────────────────
  console.log('[5/6] Creating a brand new test ticket in Intake Pending...');
  const newTicket = await hubspot.crm.tickets.basicApi.create({
    properties: {
      subject: `[LaunchPad PoC] Test ticket ${new Date().toISOString()}`,
      content: 'Test ticket created by PoC script. Safe to delete.',
      hs_pipeline: PIPELINE_ID,
      hs_pipeline_stage: STAGE_INTAKE_PENDING,
    },
  });
  console.log('      New ticket ID:', newTicket.id);
  console.log('      URL:           ', ticketUrl(newTicket.id));
  console.log('   ✓ Ticket creation works\n');

  // ── Step 6: Final verification ────────────────────────────────────────────
  console.log('[6/6] Verifying test ticket final state...');
  const final = await hubspot.crm.tickets.basicApi.getById(TEST_TICKET_ID, [
    'subject',
    'hs_pipeline_stage',
    'health_status',
  ]);
  const stageBackToOriginal = final.properties.hs_pipeline_stage === originalStage;
  console.log('      Stage:', final.properties.hs_pipeline_stage, stageBackToOriginal ? '✓ reverted' : '✗ NOT reverted');
  console.log('      Health:', final.properties.health_status ?? '(unset)');

  console.log('\n═══ PoC complete ═══');
  console.log('Test ticket:    ', ticketUrl(TEST_TICKET_ID));
  console.log('New test ticket:', ticketUrl(newTicket.id));
  console.log('\nNext: spot-check the test ticket in HubSpot UI — confirm the note appears,');
  console.log('the new ticket exists, and the test ticket\'s stage is back to original.');
  console.log('Delete the new test ticket from HubSpot UI when done.');
}

main().catch((err) => {
  console.error('\n✗ PoC failed:');
  console.error(err.message ?? err);
  if (err.response?.body) {
    console.error('\nResponse body:');
    console.error(JSON.stringify(err.response.body, null, 2));
  }
  process.exit(1);
});
