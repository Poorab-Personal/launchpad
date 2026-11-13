import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Contract test for the Rejig account sync (Phase 1 of
 * docs/plans/rejig-account-sync.md). Builds the exact JSON LaunchPad will
 * POST for real customers, prints it, and with --send-dev posts it to
 * **Rejig dev**.
 *
 * Read-only on LaunchPad: no audit rows (that table arrives in P2), no name
 * writes. Only ever talks to Rejig dev — it never loads the prod key.
 *
 * Real brand kits don't exist until P2, so the kit comes from a fixture
 * (default scripts/fixtures/rejig-brand-kit.example.json). Any logo slot the
 * fixture leaves empty is filled from the customer's uploaded logo, else the
 * brokerage master logo, so each payload looks like that brokerage.
 *
 * Usage:
 *   npx tsx scripts/rejig-sync-preview.ts                     # latest customer per workflow, print only
 *   npx tsx scripts/rejig-sync-preview.ts --ids <uuid>,<uuid> # specific customers
 *   npx tsx scripts/rejig-sync-preview.ts --ids <uuid> --send-dev
 *   npx tsx scripts/rejig-sync-preview.ts --brand-kit path/to/kit.json
 */

import fs from 'node:fs';
import path from 'node:path';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const sendDev = process.argv.includes('--send-dev');
  const idsArg = arg('--ids');
  const kitPath = arg('--brand-kit') ?? 'scripts/fixtures/rejig-brand-kit.example.json';

  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { and, desc, eq, isNull, sql } = await import('drizzle-orm');
  const { getCustomerById, getBrokerageById } = await import('../src/lib/db');
  const { buildRejigPayload, resolveAgentName, syncPreflight } = await import(
    '../src/lib/rejig-sync/payload'
  );
  const { postCustomerToRejig, isRejigEnvConfigured } = await import(
    '../src/lib/integrations/rejig/onboarding'
  );
  type BrandKit = import('../src/lib/brand-kit').BrandKit;
  type ProductTier = import('../src/types').ProductTier;

  const fixture = JSON.parse(fs.readFileSync(path.resolve(kitPath), 'utf8')) as {
    accountType?: ProductTier;
    brandKit: BrandKit;
  };

  let ids: string[];
  if (idsArg) {
    ids = idsArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    // Latest customer per workflow that has a website (Rejig requires one).
    const rows = await db.execute<{ id: string }>(sql`
      SELECT DISTINCT ON (workflow_key) id
      FROM customers
      WHERE COALESCE(website, '') <> ''
      ORDER BY workflow_key, created_at DESC
    `);
    ids = rows.rows.map((r) => r.id);
  }

  if (sendDev && !isRejigEnvConfigured('dev')) {
    throw new Error('REJIG_ONBOARDING_DEV_API_KEY is not set in .env.local.');
  }

  for (const id of ids) {
    const customer = await getCustomerById(id);
    if (!customer) {
      console.log(`\n✗ ${id}: customer not found`);
      continue;
    }
    const brokerage = customer.brokerage[0] ? await getBrokerageById(customer.brokerage[0]) : null;

    const [roster] = await db
      .select({ firstName: schema.brokerageRoster.firstName, lastName: schema.brokerageRoster.lastName })
      .from(schema.brokerageRoster)
      .where(and(eq(schema.brokerageRoster.customerId, id), isNull(schema.brokerageRoster.deletedAt)))
      .orderBy(desc(schema.brokerageRoster.lastSyncedAt))
      .limit(1);

    const name = resolveAgentName({ roster: roster ?? null, name: customer.name });

    const fallbackLogo =
      customer.businessLogo[0]?.url || brokerage?.masterLogoUrl || '';
    const brandKit: BrandKit = {
      ...fixture.brandKit,
      logos: {
        ...fixture.brandKit.logos,
        primary: fixture.brandKit.logos?.primary ?? (fallbackLogo ? { url: fallbackLogo } : undefined),
      },
    };
    const input = {
      customer: { ...customer, productTier: customer.productTier ?? fixture.accountType ?? null },
      brokerage: brokerage ? { name: brokerage.name, shortName: brokerage.shortName } : null,
      name,
      brandKit,
    };

    const missing = syncPreflight(input);
    const payload = buildRejigPayload(input);

    console.log(`\n━━━ ${customer.name} · ${customer.workflowKey} · ${id}`);
    console.log(`name source: ${name.source}${name.source === 'guessed' ? '  ⚠ GUESSED — check before syncing' : ''}`);
    console.log(JSON.stringify(payload, null, 2));

    if (missing.length > 0) {
      console.log(`✗ pre-flight: missing ${missing.join(', ')}`);
      continue;
    }
    if (!sendDev) continue;

    const result = await postCustomerToRejig('dev', payload);
    console.log(
      `→ Rejig dev: ${result.outcome} (HTTP ${result.httpStatus ?? '—'}, ${result.durationMs}ms)` +
        (result.rejigCode ? ` code=${result.rejigCode}` : '') +
        (result.message ? ` — ${result.message}` : ''),
    );
    console.log(JSON.stringify(result.response, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
