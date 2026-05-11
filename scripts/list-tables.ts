/**
 * Quick verifier: list tables and basic column counts in the connected DB.
 * Useful after `npm run db:migrate` to confirm what landed.
 *
 * Run: npm run db:list
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

async function main() {
  const tables = await db.execute(sql`
    SELECT table_name,
           (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS col_count
    FROM information_schema.tables t
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log('Tables in public schema:');
  for (const row of tables.rows) {
    console.log(`  ${row.table_name.padEnd(40)} ${row.col_count} cols`);
  }

  const constraints = await db.execute(sql`
    SELECT conname AS name, contype AS type
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND contype IN ('c', 'u', 'f')
    ORDER BY conname
  `);
  console.log('\nConstraints (c=check, u=unique, f=fk):');
  for (const row of constraints.rows) {
    console.log(`  [${row.type}] ${row.name}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Query failed:', err);
  process.exit(1);
});
