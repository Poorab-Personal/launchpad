/**
 * Phase 1b of the DMG roster integration plan (docs/integrations/dmg-roster-plan.md §3.2):
 * backfill the Keyes + Baird & Warner brokerage rows with the new columns
 * landed in migration 0013 (source_type / source_config / verification_mode /
 * support_contact_*) and 0014 (master_logo_url).
 *
 * Idempotent — UPDATE WHERE landing_page_slug is naturally idempotent.
 * Re-running writes the same values.
 *
 * NOTE: Several values are TBD placeholders; fill them in before running.
 *   - supportContactName / Email / Phone for BOTH brokerages
 *   - masterLogoUrl for B&W (Keyes is known from legacy Config.gs)
 *
 * Usage: npx tsx scripts/seed-existing-brokerages-source.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

type BackfillRow = {
  // Per-brokerage values, keyed by landing_page_slug.
  sourceType: 'dmg';
  sourceConfig: { credEnvPrefix: string };
  verificationMode: 'soft';
  supportContactName: string | null;
  supportContactEmail: string | null;
  supportContactPhone: string | null;
  masterLogoUrl: string | null;
};

const BACKFILL: Record<string, BackfillRow> = {
  // Keyes
  keyes: {
    sourceType: 'dmg',
    sourceConfig: { credEnvPrefix: 'DMG_KEYES' },
    verificationMode: 'soft',
    // TODO(user): fill in real support contact for Keyes before running.
    supportContactName: 'TBD_KEYES_SUPPORT_NAME',
    supportContactEmail: 'TBD_KEYES_SUPPORT_EMAIL',
    supportContactPhone: 'TBD_KEYES_SUPPORT_PHONE',
    // Known good — verified from legacy Config.gs (agent_photo_strategy memory).
    masterLogoUrl: 'https://www.keyes.com/i/uploads/2020/12/keyes-new-logo.png',
  },

  // Baird & Warner
  bw: {
    sourceType: 'dmg',
    sourceConfig: { credEnvPrefix: 'DMG_BAIRD_WARNER' },
    verificationMode: 'soft',
    // TODO(user): fill in real support contact for B&W before running.
    supportContactName: 'TBD_BW_SUPPORT_NAME',
    supportContactEmail: 'TBD_BW_SUPPORT_EMAIL',
    supportContactPhone: 'TBD_BW_SUPPORT_PHONE',
    // TODO(user): fill in real B&W master logo URL before running.
    masterLogoUrl: 'TBD_BW_MASTER_LOGO_URL',
  },
};

async function main() {
  const { db } = await import('../src/db');
  const { brokerages } = await import('../src/db/schema/brokerages');
  const { eq } = await import('drizzle-orm');

  let updatedTotal = 0;

  for (const [slug, row] of Object.entries(BACKFILL)) {
    const result = await db
      .update(brokerages)
      .set({
        sourceType: row.sourceType,
        sourceConfig: row.sourceConfig,
        verificationMode: row.verificationMode,
        supportContactName: row.supportContactName,
        supportContactEmail: row.supportContactEmail,
        supportContactPhone: row.supportContactPhone,
        masterLogoUrl: row.masterLogoUrl,
      })
      .where(eq(brokerages.landingPageSlug, slug))
      .returning({
        id: brokerages.id,
        name: brokerages.name,
        slug: brokerages.landingPageSlug,
        sourceType: brokerages.sourceType,
        sourceConfig: brokerages.sourceConfig,
        verificationMode: brokerages.verificationMode,
        supportContactName: brokerages.supportContactName,
        supportContactEmail: brokerages.supportContactEmail,
        supportContactPhone: brokerages.supportContactPhone,
        masterLogoUrl: brokerages.masterLogoUrl,
      });

    if (result.length === 0) {
      console.warn(`No brokerage found with landing_page_slug='${slug}' — skipping.`);
      continue;
    }
    updatedTotal += result.length;
    const r = result[0];
    console.log(`Updated: ${r.name} (slug=${r.slug})`);
    console.log(`  sourceType         = ${r.sourceType}`);
    console.log(`  sourceConfig       = ${JSON.stringify(r.sourceConfig)}`);
    console.log(`  verificationMode   = ${r.verificationMode}`);
    console.log(`  supportContactName = ${r.supportContactName}`);
    console.log(`  supportContactEmail= ${r.supportContactEmail}`);
    console.log(`  supportContactPhone= ${r.supportContactPhone}`);
    console.log(`  masterLogoUrl      = ${r.masterLogoUrl}`);
  }

  console.log(`\nDone. Updated ${updatedTotal} brokerage row(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
