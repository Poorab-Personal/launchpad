/**
 * Phase 0 — Destructive cleanup of legacy reminder fields.
 *
 * Deletes three dead-weight fields confirmed via code grep:
 *  - Customers.Reminder Count
 *  - Workflow Templates.Reminder After Days
 *  - Workflow Templates.Max Reminders
 *
 * All three are read by the airtable.ts mapper (which has been updated to no
 * longer reference them) and written to nowhere except seed/mock data. No
 * business logic consumes them. Confirmed unused as of 2026-05-06.
 *
 * Safety: requires CONFIRM=yes in env to actually run (otherwise prints what
 * would happen and exits 0). The destructive op is field deletion via the
 * Airtable Meta API.
 *
 * Usage:
 *   npx tsx scripts/phase0-cleanup-legacy-reminder-fields.ts          (dry run)
 *   CONFIRM=yes npx tsx scripts/phase0-cleanup-legacy-reminder-fields.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;
const CONFIRM = process.env.CONFIRM === 'yes';

if (!PAT || !BASE_ID) {
  console.error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID in .env.local');
  process.exit(1);
}

const META = `https://api.airtable.com/v0/meta/bases/${BASE_ID}`;
const H = { Authorization: `Bearer ${PAT}` };

interface Field {
  id: string;
  name: string;
  type: string;
}
interface Table {
  id: string;
  name: string;
  fields: Field[];
}

async function listTables(): Promise<Table[]> {
  const res = await fetch(`${META}/tables`, { headers: H });
  if (!res.ok) throw new Error(`List tables failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { tables: Table[] };
  return data.tables;
}

async function deleteField(tableId: string, fieldId: string) {
  const res = await fetch(`${META}/tables/${tableId}/fields/${fieldId}`, {
    method: 'DELETE',
    headers: H,
  });
  if (!res.ok) {
    throw new Error(`Delete field ${fieldId} failed: ${res.status} ${await res.text()}`);
  }
}

const TARGETS: Array<{ table: string; field: string }> = [
  { table: 'Customers', field: 'Reminder Count' },
  { table: 'Workflow Templates', field: 'Reminder After Days' },
  { table: 'Workflow Templates', field: 'Max Reminders' },
];

async function main() {
  console.log(`Phase 0 — Legacy reminder field cleanup ${CONFIRM ? '(LIVE RUN)' : '(DRY RUN — set CONFIRM=yes to execute)'}\n`);

  const tables = await listTables();
  const tableByName = new Map(tables.map((t) => [t.name, t]));

  const ops: Array<{ table: Table; field: Field }> = [];
  let missing = 0;

  for (const t of TARGETS) {
    const table = tableByName.get(t.table);
    if (!table) {
      console.error(`  ✗ Table "${t.table}" not found`);
      process.exit(1);
    }
    const field = table.fields.find((f) => f.name === t.field);
    if (!field) {
      console.log(`  ✓ "${t.table}.${t.field}" already absent — skipping`);
      missing++;
      continue;
    }
    ops.push({ table, field });
  }

  if (ops.length === 0) {
    console.log('\nNothing to do. All target fields already absent.');
    return;
  }

  console.log('\nFields to delete:');
  for (const { table, field } of ops) {
    console.log(`  - ${table.name}.${field.name} (id=${field.id}, type=${field.type})`);
  }

  if (!CONFIRM) {
    console.log('\n[DRY RUN] No changes made. Re-run with CONFIRM=yes to delete.');
    return;
  }

  console.log('\nExecuting deletes...');
  for (const { table, field } of ops) {
    await deleteField(table.id, field.id);
    console.log(`  ✓ Deleted ${table.name}.${field.name}`);
  }

  console.log(`\n✓ Done. ${ops.length} field(s) deleted, ${missing} already absent.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
