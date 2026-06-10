import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Backfill customers stranded at currentStage='Prepare for Onboarding' whose
 * HubSpot ticket already reached a post-launch state (Active, Watch, At-Risk,
 * Critical, On Hold). Uses the same advanceToLaunchedFromHsActive helper that
 * the live HS webhook now uses, so production behavior and backfill behavior
 * stay byte-identical.
 *
 * Usage:
 *   npx tsx scripts/backfill-stranded-launched.ts          # dry-run (default)
 *   npx tsx scripts/backfill-stranded-launched.ts --apply  # actually advance
 */

async function main() {
  const apply = process.argv.includes('--apply');

  const { db } = await import('../src/db');
  const { customers } = await import('../src/db/schema/customers');
  const { and, eq, inArray } = await import('drizzle-orm');
  const { advanceToLaunchedFromHsActive } = await import('../src/lib/automations/advance-to-launched-from-hs');

  // Mirrors the webhook guard: terminal pre-launch stage + post-launch HS state.
  // We DO NOT widen to 'Backfilled' customers — they were imported retroactively
  // with no LP task pipeline, and the helper's guard (`currentStage ===
  // 'Prepare for Onboarding'`) would refuse them anyway. Excluding them up-front
  // makes the dry-run output meaningful.
  const candidates = await db.select({
    id: customers.id,
    name: customers.name,
    workflowKey: customers.workflowKey,
    currentStage: customers.currentStage,
    onboardingState: customers.onboardingState,
    accountCreated: customers.accountCreated,
    credentialsSent: customers.credentialsSent,
    hubspotTicketId: customers.hubspotTicketId,
  })
    .from(customers)
    .where(and(
      eq(customers.currentStage, 'Prepare for Onboarding'),
      inArray(customers.onboardingState, ['Active', 'Watch', 'At-Risk', 'Critical', 'On Hold']),
    ));

  console.log(`\nFound ${candidates.length} stranded candidate(s).`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

  let advanced = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();

  for (const c of candidates) {
    const status = c.accountCreated ? '✓ creds' : '✗ NO CREDS';
    const line = `  ${c.name.padEnd(50).slice(0, 50)}  ${c.workflowKey.padEnd(11)}  HS=${(c.onboardingState ?? '-').padEnd(8)}  ${status}`;

    if (!apply) {
      console.log(line);
      if (!c.accountCreated) {
        skipped++;
        skipReasons.set('accountCreated=false', (skipReasons.get('accountCreated=false') ?? 0) + 1);
      } else {
        advanced++;
      }
      continue;
    }

    try {
      const result = await advanceToLaunchedFromHsActive(c.id, 'backfill');
      if (result.kind === 'advanced') {
        advanced++;
        console.log(`${line}  → advanced (${result.completedTaskIds.length} tasks completed)`);
      } else {
        skipped++;
        skipReasons.set(result.reason, (skipReasons.get(result.reason) ?? 0) + 1);
        console.log(`${line}  → skipped (${result.reason})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped++;
      skipReasons.set(`ERROR: ${msg}`, (skipReasons.get(`ERROR: ${msg}`) ?? 0) + 1);
      console.log(`${line}  → ERROR: ${msg}`);
    }
  }

  console.log(`\nSummary (${apply ? 'APPLY' : 'DRY-RUN'}):`);
  console.log(`  Would advance: ${advanced}`);
  console.log(`  Would skip:    ${skipped}`);
  if (skipReasons.size > 0) {
    console.log(`  Skip reasons:`);
    for (const [reason, count] of skipReasons) {
      console.log(`    ${count.toString().padStart(4)}  ${reason}`);
    }
  }

  if (!apply) {
    console.log(`\nRun with --apply to actually advance.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
