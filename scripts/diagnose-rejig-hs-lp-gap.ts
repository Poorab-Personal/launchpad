/**
 * Cross-tab diagnostic for the Rejig × HubSpot × LP identity gap.
 *
 * For every Rejig account fetched from the API, classifies it into one of
 * 4 buckets based on whether an HS Contact and/or an LP customer exist
 * for the same email:
 *
 *   A. In Rejig + In HS + In LP        — fully linked (today: ~0)
 *   B. In Rejig + In HS + NOT in LP    — biggest cohort: pre-LP active customers
 *   C. In Rejig + NOT in HS + In LP    — weird; should be near-zero
 *   D. In Rejig + NOT in HS + NOT in LP — the orphan cohort the user thinks is ~150
 *
 * Also surfaces:
 *   - Rejig customers with subscription_status='canceled' or 'deactivated'
 *     (Churned cohort — backfill but mark as Churned, not Active)
 *   - HS Contact-email conflicts (multiple HS Contacts with the same email)
 *
 * No writes. Just numbers + a small sample (5 emails) per bucket.
 *
 * Usage: npx tsx --env-file=.env.local scripts/diagnose-rejig-hs-lp-gap.ts
 */
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { Client } from '@hubspot/api-client';
import { fetchAccountsSnapshot } from '@/lib/integrations/rejig/client';

const SAMPLE_SIZE = 5;

async function main() {
  console.log('[diag] Fetching Rejig snapshot…');
  const accounts = await fetchAccountsSnapshot();
  console.log(`[diag] Rejig: ${accounts.length} accounts`);

  console.log('[diag] Loading LP customers (email keyed)…');
  const result = await db.execute(sql`
    SELECT id, name, contact_email, onboarding_state, subscription_status
    FROM customers
  `);
  // Neon driver returns rows directly on the result array OR under .rows
  // depending on driver version
  const lpRows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    id: string;
    name: string;
    contact_email: string | null;
    onboarding_state: string | null;
    subscription_status: string | null;
  }>;
  const lpByEmail = new Map<string, (typeof lpRows)[number]>();
  for (const r of lpRows) {
    if (r.contact_email) {
      lpByEmail.set(r.contact_email.toLowerCase().trim(), r);
    }
  }
  console.log(`[diag] LP: ${lpRows.length} customers (${lpByEmail.size} with email)`);

  console.log('[diag] Searching HubSpot for matching Contacts by email (this takes a minute)…');
  const hs = new Client({ accessToken: process.env.HUBSPOT_STATIC_TOKEN! });
  const hsEmails = new Set<string>();
  // HubSpot doesn't have a "list contacts by email IN (...)" endpoint we can
  // batch easily. Best practical approach: iterate Rejig emails, search HS
  // per-batch of 10 via the search API with OR filters.
  const rejigEmails = accounts
    .map((a) => (a.email ?? '').toLowerCase().trim())
    .filter((e) => e.length > 0 && e.includes('@'));
  const unique = Array.from(new Set(rejigEmails));
  console.log(`[diag] Unique Rejig emails to check against HS: ${unique.length}`);

  // HubSpot search: 1 filterGroup with 1 filter using `IN` operator that
  // accepts up to 100 values per call. Returns up to 100 results — at our
  // volume (685 emails) we do ~7 calls instead of 137 single-email queries.
  let checked = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    try {
      const res = await hs.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
            filters: [{
              propertyName: 'email',
              operator: 'IN' as never,
              values: batch,
            } as never],
          },
        ],
        properties: ['email'],
        limit: 100,
        sorts: [],
        after: undefined as unknown as string,
      });
      for (const r of res.results) {
        const e = (r.properties?.email ?? '').toLowerCase().trim();
        if (e) hsEmails.add(e);
      }
    } catch (err) {
      console.warn(`[diag] HS search batch ${i / 100} failed: ${err instanceof Error ? err.message : err}`);
    }
    checked += batch.length;
    console.log(`[diag] HS lookups: ${checked} / ${unique.length} (found in HS so far: ${hsEmails.size})`);
  }

  // Classification
  const buckets = {
    A_inAll: [] as string[],
    B_rejigHsNotLp: [] as string[],
    C_rejigLpNotHs: [] as string[],
    D_rejigOnly: [] as string[],
  };

  for (const acct of accounts) {
    const email = (acct.email ?? '').toLowerCase().trim();
    if (!email) continue;
    const inHs = hsEmails.has(email);
    const inLp = lpByEmail.has(email);
    if (inHs && inLp) buckets.A_inAll.push(email);
    else if (inHs && !inLp) buckets.B_rejigHsNotLp.push(email);
    else if (!inHs && inLp) buckets.C_rejigLpNotHs.push(email);
    else buckets.D_rejigOnly.push(email);
  }

  // Subscription status breakdown
  const statusCounts: Record<string, number> = {};
  for (const acct of accounts) {
    const s = acct.subscription_status ?? '__null__';
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  console.log('\n============================================');
  console.log('   REJIG × HS × LP IDENTITY GAP REPORT');
  console.log('============================================');
  console.log(`\nRejig accounts fetched:        ${accounts.length}`);
  console.log(`Rejig with email:              ${rejigEmails.length}`);
  console.log(`Rejig with unique email:       ${unique.length}`);
  console.log(`HS Contacts matched by email:  ${hsEmails.size}`);
  console.log(`LP customers (with email):     ${lpByEmail.size}`);

  console.log('\n— Cross-tabulation —');
  console.log(`A. In all 3 (Rejig + HS + LP):              ${buckets.A_inAll.length}`);
  console.log(`B. Rejig + HS, NOT in LP:                   ${buckets.B_rejigHsNotLp.length}   ← biggest cohort`);
  console.log(`C. Rejig + LP, NOT in HS:                   ${buckets.C_rejigLpNotHs.length}`);
  console.log(`D. Rejig only (not in HS, not in LP):       ${buckets.D_rejigOnly.length}   ← user's "~150"`);
  console.log(`   sum:                                     ${buckets.A_inAll.length + buckets.B_rejigHsNotLp.length + buckets.C_rejigLpNotHs.length + buckets.D_rejigOnly.length}`);

  console.log('\n— Rejig subscription_status breakdown —');
  for (const [s, c] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${c}`);
  }

  console.log('\n— Samples (up to 5 per bucket) —');
  for (const [k, arr] of Object.entries(buckets)) {
    console.log(`\n  ${k}: ${arr.length} rows`);
    for (const e of arr.slice(0, SAMPLE_SIZE)) console.log(`    ${e}`);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
