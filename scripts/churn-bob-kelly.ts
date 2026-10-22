/**
 * Mark Bob Kelly (Ruhl) as Churned — he confirmed he is not interested
 * (2026-10-22).
 *
 * Deliberately NOT a delete. The row carries 28 events, the designer's asset
 * notes and 3 design drafts; and a delete would neither close his HubSpot
 * ticket nor stop the weekly DMG sync from recreating his brokerage_roster
 * row. See memory: ruhl-pilot-cohort-self-managed.
 *
 * Goes through applyStateTransition so the move is logged in
 * customer_state_transitions AND pushed to the HubSpot ticket. Idempotent:
 * re-running returns 'no-op' once he is already Churned.
 */
import { applyStateTransition, createEvent, getCustomerById } from '../src/lib/db';

const ID = 'fa6c853b-b1c3-4d26-a633-240e0efeb694';

async function main() {
  const before = await getCustomerById(ID);
  if (!before) throw new Error(`Customer ${ID} not found`);
  if (before.name !== 'Bob Kelly' || before.workflowKey !== 'B2B-RUHL') {
    throw new Error(`Refusing to write: expected Bob Kelly / B2B-RUHL, got ${before.name} / ${before.workflowKey}`);
  }
  console.log(`Before: onboarding_state=${before.onboardingState} current_stage=${before.currentStage}`);

  const result = await applyStateTransition({
    customerId: ID,
    toState: 'Churned',
    attentionReason: null,
    changeSource: 'lp_admin',
    sourceDetail: 'manual:not_interested',
    pushToHubSpot: true,
    payload: {
      confirmedBy: 'poorab@rejig.ai',
      confirmedOn: '2026-10-22',
      note: 'Agent confirmed not interested. Do not chase.',
      rejigPlanLapsedOn: '2026-09-24',
      lastRejigSignalOn: '2026-09-20',
      logins: 2,
      publishedPosts: 0,
    },
  });
  console.log('applyStateTransition →', JSON.stringify(result));

  if (result.applied) {
    await createEvent(
      ID,
      'Internal Note',
      'Team Member',
      'Marked Churned: agent confirmed not interested (2026-10-22). Removed from the Ruhl onboarding list. Record kept for history — Rejig plan lapsed 2026-09-24, 2 logins, 0 posts published.',
    );
    console.log('Audit event logged.');
  }

  const after = await getCustomerById(ID);
  console.log(`After:  onboarding_state=${after?.onboardingState} current_stage=${after?.currentStage}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
