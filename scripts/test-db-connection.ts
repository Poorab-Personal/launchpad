/**
 * Phase 0 connection smoke test.
 *
 * Verifies the Vercel-Neon connection works end-to-end with Drizzle
 * before we write any real schema or migrations.
 *
 * Run: npx tsx scripts/test-db-connection.ts
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

async function main() {
  console.log('Connecting to Postgres via Drizzle + Neon serverless...');

  const versionRes = await db.execute(sql`SELECT version() as version`);
  const nowRes = await db.execute(sql`SELECT NOW() as now`);

  console.log('Postgres version:', versionRes.rows[0].version);
  console.log('Server time:     ', nowRes.rows[0].now);
  console.log('Connection OK.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Connection failed:', err);
  process.exit(1);
});
