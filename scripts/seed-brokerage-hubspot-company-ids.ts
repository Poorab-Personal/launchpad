/**
 * Phase 1.5.5: populate brokerages.hubspot_company_id with the real HubSpot
 * Company IDs for Keyes Realty + Baird & Warner.
 *
 * Source: user-provided HubSpot URLs (2026-05-14):
 *   Keyes: https://app.hubspot.com/contacts/44956899/record/0-2/53893652348
 *   B&W:   https://app.hubspot.com/contacts/44956899/record/0-2/51123896468
 *
 * URL format: /contacts/{portalId}/record/{objectTypeId=0-2 for Company}/{companyId}
 *
 * Idempotent. Re-runnable. Matches brokerages by landing_page_slug
 * (which we've used as the channel-code anchor — 'keyes' / 'bw').
 *
 * Usage: npx tsx scripts/seed-brokerage-hubspot-company-ids.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const COMPANY_IDS: Record<string, string> = {
  // landing_page_slug → HubSpot Company ID
  'keyes': '53893652348',
  'bw':    '51123896468',
};

async function main() {
  const { db } = await import('../src/db');
  const { brokerages } = await import('../src/db/schema/brokerages');
  const { eq } = await import('drizzle-orm');

  for (const [slug, companyId] of Object.entries(COMPANY_IDS)) {
    const result = await db
      .update(brokerages)
      .set({ hubspotCompanyId: companyId })
      .where(eq(brokerages.landingPageSlug, slug))
      .returning({ id: brokerages.id, name: brokerages.name, hubspotCompanyId: brokerages.hubspotCompanyId });

    if (result.length === 0) {
      console.warn(`⚠️  No brokerage found with landing_page_slug='${slug}'`);
    } else {
      console.log(`✅ ${result[0].name} (slug=${slug}) → hubspot_company_id=${result[0].hubspotCompanyId}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
