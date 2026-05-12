/**
 * Phase 4 PITR drill — Step 1 (prep).
 *
 * 1. Creates a tiny pitr_drill table if it doesn't exist
 * 2. Inserts a uniquely-named marker row at T1 (records the timestamp)
 * 3. Waits 30 seconds (so the WAL captures the row)
 * 4. Deletes the marker at T2 (records the timestamp)
 *
 * After this runs you'll have:
 *   T1 — marker existed
 *   T2 — marker deleted
 *   Restore window: any time between T1 + ~5s and T2 - 1s
 *
 * Next: go to Neon dashboard → Branches → "Restore to point in time".
 * Pick a timestamp inside the restore window. Neon creates a branch.
 *
 * Run: npx tsx --env-file=.env.local scripts/pitr-drill-prep.ts
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

async function main() {
  const marker = `pitr-drill-${Date.now()}`;

  // 1. Table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pitr_drill (
      id serial PRIMARY KEY,
      marker text NOT NULL,
      inserted_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log('Created/verified pitr_drill table.');

  // 2. Insert marker, capture T1
  const insertRes = await db.execute<{ inserted_at: Date }>(sql`
    INSERT INTO pitr_drill (marker) VALUES (${marker})
    RETURNING inserted_at
  `);
  const T1 = new Date(insertRes.rows[0].inserted_at as unknown as string);
  console.log(`\nT1 (marker INSERT)`);
  console.log(`  UTC:   ${T1.toISOString()}`);
  console.log(`  Local: ${T1.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'long' })}`);
  console.log(`Marker value: ${marker}`);

  // 3. Wait
  console.log('\nWaiting 30 seconds before delete (so the WAL captures the insert clearly)...');
  await new Promise((r) => setTimeout(r, 30_000));

  // 4. Delete marker, capture T2
  await db.execute(sql`DELETE FROM pitr_drill WHERE marker = ${marker}`);
  const t2Res = await db.execute<{ now: Date }>(sql`SELECT now() AS now`);
  const T2 = new Date(t2Res.rows[0].now as unknown as string);
  console.log(`\nT2 (marker DELETE)`);
  console.log(`  UTC:   ${T2.toISOString()}`);
  console.log(`  Local: ${T2.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'long' })}`);

  // Safe pick: midpoint of [T1+5s, T2-1s] in LOCAL time, which is what Neon UI expects
  const safeMs = T1.getTime() + 10_000;
  const safe = new Date(safeMs);

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('NEXT STEPS — Neon dashboard restore (UI shows LOCAL time):');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`1. https://console.neon.tech → project → Branches.`);
  console.log(`2. "Restore" / "Create branch from point-in-time".`);
  console.log(`3. Pick this LOCAL time in the Neon picker:`);
  console.log(`     ${safe.toLocaleDateString('en-US')}  ${safe.toLocaleTimeString('en-US', { hour12: true })}`);
  console.log(`   (= ${safe.toISOString()} UTC, ~10s after T1)`);
  console.log(`4. Name the branch "pitr-drill-verify".`);
  console.log(`5. Open it → Connection details → copy connection string.`);
  console.log(`6. Run:\n`);
  console.log(`   POSTGRES_URL_RESTORE='<paste>' \\`);
  console.log(`     npx tsx scripts/pitr-drill-verify.ts ${marker}`);
  console.log(`\nThen delete the pitr-drill-verify branch in Neon UI.`);
  console.log('──────────────────────────────────────────────────────────');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
