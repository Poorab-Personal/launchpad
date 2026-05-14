/**
 * Phase 1.5: seed default settings rows used by the post-launch handy page.
 *
 * Idempotent — ON CONFLICT DO NOTHING. Re-runnable.
 *
 * Usage: npx tsx scripts/seed-phase-1-5-settings.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const { db } = await import('../src/db');
  const { settings } = await import('../src/db/schema/settings');

  const rows = [
    {
      key: 'default_support_meeting_url',
      value: 'https://meetings.hubspot.com/poorab',
      description:
        'Default HubSpot Meetings round-robin URL for the portal handy page support-session button. Per-brokerage overrides may land later as a brokerages.support_meeting_url column.',
    },
  ];

  for (const r of rows) {
    const res = await db
      .insert(settings)
      .values(r)
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    if (res.length > 0) console.log(`Inserted: ${r.key} = ${r.value}`);
    else console.log(`Already present: ${r.key}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
