/**
 * Manual roster sync CLI.
 *
 * Runs `syncBrokerage` for one brokerage (by landing_page_slug) against the
 * local `.env.local` Postgres + the source's live API. Used for parity
 * checks and dev runs; the production cron route (Phase 2) calls
 * `runAllActiveSyncs` directly.
 *
 * Usage:
 *   npx tsx scripts/sync-roster.ts <slug>
 *   e.g. npx tsx scripts/sync-roster.ts keyes
 *
 * Exits 0 on success, 1 on any error (missing slug, brokerage not found,
 * adapter failure, DB error, etc.).
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: npx tsx scripts/sync-roster.ts <slug>');
    console.error('Example: npx tsx scripts/sync-roster.ts keyes');
    process.exit(1);
  }

  // Dynamic imports so dotenv.config() runs before @/db loads POSTGRES_URL.
  const { db } = await import('../src/db');
  const { brokerages } = await import('../src/db/schema/brokerages');
  const { eq } = await import('drizzle-orm');
  const { syncBrokerage } = await import('../src/lib/roster/sync');

  const rows = await db
    .select()
    .from(brokerages)
    .where(eq(brokerages.landingPageSlug, slug))
    .limit(1);

  if (rows.length === 0) {
    console.error(`No brokerage found with landing_page_slug='${slug}'`);
    process.exit(1);
  }
  const brokerage = rows[0];

  if (!brokerage.active) {
    console.warn(`Brokerage ${slug} is marked inactive — syncing anyway.`);
  }

  console.log(`Syncing ${brokerage.name} (slug=${slug}, source=${brokerage.sourceType})...`);
  const result = await syncBrokerage(brokerage);

  console.log('\nSync complete:');
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
