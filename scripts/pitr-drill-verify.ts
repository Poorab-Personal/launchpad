/**
 * Phase 4 PITR drill — Step 2 (verify).
 *
 * Connects to a RESTORE branch (different POSTGRES_URL than main) and
 * checks whether the marker row exists. If it does, the restore branch
 * correctly captured state at the chosen point in time. PITR works.
 *
 * Run:
 *   POSTGRES_URL_RESTORE='<branch conn string>' \
 *     npx tsx scripts/pitr-drill-verify.ts <marker>
 *
 * Note: this script does NOT load .env.local. It uses POSTGRES_URL_RESTORE
 * from your shell, NOT the main POSTGRES_URL — so it doesn't accidentally
 * connect to the live DB.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';

async function main() {
  const url = process.env.POSTGRES_URL_RESTORE;
  if (!url) {
    console.error('POSTGRES_URL_RESTORE env var is required (the restore branch connection string).');
    process.exit(2);
  }
  const marker = process.argv[2];
  if (!marker) {
    console.error('Usage: POSTGRES_URL_RESTORE=... npx tsx scripts/pitr-drill-verify.ts <marker>');
    process.exit(2);
  }

  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  const res = await db.execute<{ marker: string; inserted_at: string }>(sql`
    SELECT marker, inserted_at::text AS inserted_at
    FROM pitr_drill
    WHERE marker = ${marker}
  `);

  if (res.rows.length === 1) {
    console.log(`✓ PITR DRILL PASSED.`);
    console.log(`  Restore branch contains marker: ${res.rows[0].marker}`);
    console.log(`  Inserted at: ${res.rows[0].inserted_at}`);
    console.log(`\nBackups verified. Phase 4 hard gate cleared.`);
    console.log('\nCleanup:');
    console.log(`  1. Delete the pitr-drill-verify branch in the Neon dashboard.`);
    console.log(`  2. (Optional) On main DB: DROP TABLE pitr_drill;`);
    await pool.end();
    process.exit(0);
  }

  console.log(`✗ PITR DRILL FAILED.`);
  console.log(`  Marker "${marker}" NOT FOUND in restore branch.`);
  console.log(`  Either the timestamp chosen was outside [T1, T2], or PITR is misconfigured.`);
  console.log(`  Re-check the timestamp you picked in the Neon UI.`);
  await pool.end();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
