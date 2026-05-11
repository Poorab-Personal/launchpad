/**
 * Quick verifier: list tables, column counts, and row counts.
 *
 * Run: npm run db:list
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

async function main() {
  const tables = await db.execute<{ table_name: string; col_count: string }>(sql`
    SELECT table_name,
           (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS col_count
    FROM information_schema.tables t
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  console.log('Tables in public schema:');
  for (const row of tables.rows) {
    const t = String(row.table_name);
    // Skip drizzle's bookkeeping table from row counts
    if (t === '__drizzle_migrations') continue;
    const countRes = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ${sql.raw(`"${t}"`)}`,
    );
    const rowCount = countRes.rows[0]?.count ?? '?';
    console.log(`  ${t.padEnd(25)} ${String(row.col_count).padStart(3)} cols  ${rowCount.padStart(5)} rows`);
  }

  const constraints = await db.execute<{ name: string; type: string }>(sql`
    SELECT conname AS name, contype AS type
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND contype IN ('c', 'u', 'f')
    ORDER BY conname
  `);
  console.log(`\nConstraints (c=check, u=unique, f=fk): ${constraints.rows.length} total`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Query failed:', err);
  process.exit(1);
});
