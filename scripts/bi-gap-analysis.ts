/**
 * BI gap analysis — surfaces identity-mapping gaps before flipping the
 * BI cron live. Pass 1 Phase 6 + Pass 2.7 §29 (no data-quality gating)
 * context: BI runs on what we have; this script tells us what we're
 * missing so we can backfill the gaps we care about.
 *
 * Read-only. No DB writes. Prints 4 reports to console. Pass --csv to
 * also dump each cohort to /tmp/bi-gap-*.csv (gitignored, local-only).
 *
 * Usage:
 *   npx tsx scripts/bi-gap-analysis.ts             # console only
 *   npx tsx scripts/bi-gap-analysis.ts --csv       # + write CSVs
 *   npx tsx scripts/bi-gap-analysis.ts --limit=N   # cap per-report rows
 *
 * Run AFTER scripts/import-rejig-snapshot.ts --apply.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { promises as fs } from 'fs';
import path from 'path';

type Row = Record<string, unknown>;

async function main() {
  const argv = process.argv.slice(2);
  const csvOut = argv.includes('--csv');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 1000;

  const { db } = await import('../src/db');
  const { customers } = await import('../src/db/schema/customers');
  const { sql, desc, isNull } = await import('drizzle-orm');

  // === Report 1: LP customers with no Rejig match ===
  // Definition: LP customer exists, but no customer_usage_signals row of
  // type 'rejig.*' where customer_id = customers.id. These are LP
  // customers we haven't been able to associate to Rejig data — probably
  // because their email in LP doesn't match Rejig email exactly.
  const lpNoRejigResult = await db.execute(sql`
    SELECT c.id, c.name, c.contact_email, c.platform_email, c.workflow_key,
           c.subscription_status, c.created_at
    FROM customers c
    WHERE NOT EXISTS (
      SELECT 1 FROM customer_usage_signals s
      WHERE s.customer_id = c.id
        AND s.signal_type LIKE 'rejig.%'
    )
    ORDER BY c.created_at DESC
    LIMIT ${limit}
  `);
  const lpNoRejig = extractRows(lpNoRejigResult);
  printReport('1. LP customers with no Rejig match', lpNoRejig);

  // === Report 2: Rejig accounts with no LP customer (orphan signals) ===
  // Definition: signals exist with customer_id IS NULL + rejig_user_id IS NOT NULL.
  // Group by rejig_user_id to dedupe across signal types. Pull the latest
  // signal_value_jsonb for context (email, business name, _id, snapshotDate).
  const rejigOrphansResult = await db.execute(sql`
    SELECT DISTINCT ON (rejig_user_id)
      rejig_user_id,
      signal_value_jsonb,
      observed_at
    FROM customer_usage_signals
    WHERE customer_id IS NULL
      AND rejig_user_id IS NOT NULL
      AND signal_type = 'rejig.last_login'
    ORDER BY rejig_user_id, observed_at DESC
    LIMIT ${limit}
  `);
  const rejigOrphans = extractRows(rejigOrphansResult);
  printReport('2. Rejig accounts with no LP customer (orphan signals)', rejigOrphans);

  // === Report 3: LP customers with no hubspotTicketId ===
  // Customers BI would evaluate but couldn't push to HS — silent skip.
  const lpNoTicket = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.contactEmail,
      workflowKey: customers.workflowKey,
      hubspotContactId: customers.hubspotContactId,
      currentStage: customers.currentStage,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(isNull(customers.hubspotTicketId))
    .orderBy(desc(customers.createdAt))
    .limit(limit);
  printReport('3. LP customers with no hubspotTicketId', lpNoTicket as Row[]);

  // === Report 4: LP customers with no stripeSubscriptionId ===
  // For trial-mode workflows (B2B-Keyes) this means trial not yet
  // activated. For other workflows it may be normal (B2B-BW agents don't
  // pay) or problematic (D2C pre-launch).
  const lpNoStripe = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.contactEmail,
      workflowKey: customers.workflowKey,
      subscriptionStatus: customers.subscriptionStatus,
      currentStage: customers.currentStage,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(isNull(customers.stripeSubscriptionId))
    .orderBy(desc(customers.createdAt))
    .limit(limit);
  printReport('4. LP customers with no stripeSubscriptionId', lpNoStripe as Row[]);

  // === Aggregate summary ===
  console.log('\n=========================================');
  console.log('SUMMARY');
  console.log('=========================================');
  console.log(`Report 1 (LP no Rejig match):       ${lpNoRejig.length} rows`);
  console.log(`Report 2 (Rejig orphan signals):    ${rejigOrphans.length} rows`);
  console.log(`Report 3 (LP no HS ticket):         ${lpNoTicket.length} rows`);
  console.log(`Report 4 (LP no Stripe sub):        ${lpNoStripe.length} rows`);

  console.log('\nNext steps:');
  console.log('  - Report 1: investigate emails — typo or churned out of Rejig?');
  console.log('  - Report 2: decide if these Rejig accounts should become LP customers');
  console.log('  - Report 3: run scripts/backfill-b2b-hubspot-tickets.ts (or equivalent for D2C)');
  console.log('  - Report 4: B2B-Keyes / IPRE without Stripe sub = trial-activation gap');

  if (csvOut) {
    const targets: Array<{ name: string; rows: Row[] }> = [
      { name: 'bi-gap-1-lp-no-rejig.csv', rows: lpNoRejig },
      { name: 'bi-gap-2-rejig-orphans.csv', rows: rejigOrphans },
      { name: 'bi-gap-3-lp-no-hs-ticket.csv', rows: lpNoTicket as Row[] },
      { name: 'bi-gap-4-lp-no-stripe-sub.csv', rows: lpNoStripe as Row[] },
    ];
    console.log('\n[csv] writing files to /tmp/');
    for (const t of targets) {
      const outPath = path.join('/tmp', t.name);
      await fs.writeFile(outPath, toCsv(t.rows), 'utf8');
      console.log(`  ${outPath}  (${t.rows.length} rows)`);
    }
  }
}

/**
 * Extract row array from a Drizzle `db.execute` result. The Neon
 * serverless driver returns rows directly on the object as an array,
 * while node-postgres style returns `{ rows: [...] }`. Handle both.
 */
function extractRows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const r = (result as { rows?: unknown }).rows;
    if (Array.isArray(r)) return r as Row[];
  }
  return [];
}

function printReport(title: string, rows: Row[]) {
  console.log('\n========================================');
  console.log(title);
  console.log('========================================');
  if (!rows || rows.length === 0) {
    console.log('(no rows — gap is empty)');
    return;
  }
  console.log(`${rows.length} rows:`);
  for (const r of rows.slice(0, 20)) {
    console.log('  ' + JSON.stringify(r));
  }
  if (rows.length > 20) {
    console.log(`  ... and ${rows.length - 20} more (pass --csv to dump all)`);
  }
}

/**
 * Minimal CSV serializer. Header row from the union of keys across
 * rows (preserves insertion order of first-seen keys). Values are
 * stringified; nulls/undefined → empty cell; objects → JSON; values
 * containing comma, quote, CR, or LF are double-quoted with internal
 * quotes doubled per RFC 4180.
 */
function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s: string;
    if (v instanceof Date) s = v.toISOString();
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines: string[] = [];
  lines.push(keys.join(','));
  for (const r of rows) {
    lines.push(keys.map((k) => escape((r as Row)[k])).join(','));
  }
  return lines.join('\n') + '\n';
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
