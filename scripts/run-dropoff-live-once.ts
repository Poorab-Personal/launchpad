/**
 * One-time manual trigger for the drop-off reminder cron (Tracks 1/2/5) and
 * the B2B digest (Tracks 3/4), run live (dryRun: false) — used once to fire
 * on the existing backlog after the 2026-08-06 decision to include it
 * rather than grandfather it out (ROLLOUT_CUTOFF_DATE lowered to 2020).
 *
 * After this run, normal operation continues via the deployed crons
 * (daily-checks for 1/2/5, weekly→dropoff-digest for 3/4) — this script
 * doesn't need to run again.
 *
 * Run: npx tsx --env-file=.env.local scripts/run-dropoff-live-once.ts
 */
import { runDropoffReminders, type DropoffAction } from '@/lib/automations/dropoff-reminders';
import { computeB2BDropoffDigest } from '@/lib/automations/dropoff-b2b-digest';
import { sendDropoffB2BDigestEmail } from '@/lib/email/send';

const DIGEST_TO = 'success@rejig.ai';
const DIGEST_CC = ['poorab@rejig.ai', 'matt@rejig.ai'];

async function main() {
  console.log('=== LIVE RUN — sending real emails, writing real DB state ===\n');

  const { actions, durationMs } = await runDropoffReminders({ dryRun: false });

  const byKind = new Map<DropoffAction['kind'], number>();
  for (const a of actions) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);

  console.log(`Tracks 1/2/5 complete in ${durationMs}ms:`);
  for (const [kind, count] of byKind) console.log(`  ${kind}: ${count}`);
  const skipped = actions.filter((a) => a.kind === 'skipped');
  if (skipped.length > 0) {
    console.log('\nSkipped:');
    for (const s of skipped) {
      if (s.kind === 'skipped') console.log(`  ${s.customerName} — ${s.taskName} — ${s.reason}`);
    }
  }

  // Track 3/4 — B2B digest
  console.log('\n--- B2B digest ---');
  const digest = await computeB2BDropoffDigest();
  if (digest.rows.length === 0) {
    console.log('No B2B digest rows — skipping send.');
  } else {
    const digestDate = new Date().toISOString().slice(0, 10);
    await sendDropoffB2BDigestEmail({
      to: DIGEST_TO,
      cc: DIGEST_CC,
      digestDate,
      rows: digest.rows,
    });
    console.log(`B2B digest sent: ${digest.rows.length} rows (${digest.rows.filter((r) => r.isHotCase).length} hot) → ${DIGEST_TO} (cc: ${DIGEST_CC.join(', ')})`);
  }

  console.log('\n=== DONE ===');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
