/**
 * Phase 1.2 + 1.3 — Create Stripe Plans table + seed Keyes plans + add Customer fields.
 *
 * What this script does (idempotent):
 *  1. Creates the Stripe Plans table if missing (5 columns: Plan Name, Workflow Key,
 *     Stripe Price ID, Active, Description).
 *  2. Seeds 2 Keyes plans using STRIPE_MONTHLY_PRICE_ID and STRIPE_QUARTERLY_PRICE_ID
 *     env vars. Skips if rows with the same Plan Name already exist.
 *  3. Adds Customers.Selected Stripe Price ID + Customers.Selected Plan Name
 *     (text fields). Skips if already present.
 *
 * Usage: npx tsx scripts/phase1.2-stripe-plans-table.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;
const MONTHLY_PRICE = process.env.STRIPE_MONTHLY_PRICE_ID;
const QUARTERLY_PRICE = process.env.STRIPE_QUARTERLY_PRICE_ID;

if (!PAT || !BASE_ID) {
  console.error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID in .env.local');
  process.exit(1);
}
if (!MONTHLY_PRICE || !QUARTERLY_PRICE) {
  console.error('Missing STRIPE_MONTHLY_PRICE_ID or STRIPE_QUARTERLY_PRICE_ID in .env.local');
  process.exit(1);
}

const META = `https://api.airtable.com/v0/meta/bases/${BASE_ID}`;
const API = `https://api.airtable.com/v0/${BASE_ID}`;
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

interface Field { id: string; name: string; type: string }
interface Table { id: string; name: string; fields: Field[] }

async function listTables(): Promise<Table[]> {
  const res = await fetch(`${META}/tables`, { headers: H });
  if (!res.ok) throw new Error(`List tables failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { tables: Table[] }).tables;
}

async function createTable(spec: { name: string; description?: string; fields: Array<Record<string, unknown>> }): Promise<Table> {
  const res = await fetch(`${META}/tables`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(spec),
  });
  if (!res.ok) throw new Error(`Create table failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function addField(tableId: string, field: Record<string, unknown>) {
  const res = await fetch(`${META}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(field),
  });
  if (!res.ok) throw new Error(`Add field "${field.name}" failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchAll(tableId: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const all: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${API}/${tableId}`);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers: H });
    if (!res.ok) throw new Error(`Fetch ${tableId} failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { records: Array<{ id: string; fields: Record<string, unknown> }>; offset?: string };
    all.push(...data.records);
    offset = data.offset;
  } while (offset);
  return all;
}

async function createRecords(tableId: string, records: Array<{ fields: Record<string, unknown> }>) {
  const res = await fetch(`${API}/${tableId}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ records }),
  });
  if (!res.ok) throw new Error(`POST ${tableId} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ensureField(table: Table, field: Record<string, unknown> & { name: string }) {
  if (table.fields.some((f) => f.name === field.name)) {
    console.log(`  ✓ "${field.name}" exists — skipping`);
    return;
  }
  await addField(table.id, field);
  console.log(`  ✓ Added "${field.name}"`);
}

// ─────────────────────────────────────────────────────────────────────

const PLANS_TABLE_NAME = 'Stripe Plans';

async function ensurePlansTable(): Promise<Table> {
  const tables = await listTables();
  const existing = tables.find((t) => t.name === PLANS_TABLE_NAME);
  if (existing) {
    console.log(`  ✓ "${PLANS_TABLE_NAME}" table already exists`);
    return existing;
  }
  console.log(`  Creating "${PLANS_TABLE_NAME}" table...`);
  await createTable({
    name: PLANS_TABLE_NAME,
    description:
      'Per-workflow Stripe pricing plans. One row per offered plan (e.g., Keyes Monthly, Keyes Quarterly Prepay). Customer.Selected Stripe Price ID points at the chosen plan via its price_id (text, not link).',
    fields: [
      {
        name: 'Plan Name',
        type: 'singleLineText',
        description: 'Display name shown in customer portal (e.g., "Keyes Monthly", "Keyes Quarterly Prepay")',
      },
      {
        name: 'Workflow Key',
        type: 'singleLineText',
        description: 'Must match a Workflow Templates.Workflow Key (e.g., B2B-Keyes). Plans are filtered by this when shown in the portal.',
      },
      {
        name: 'Stripe Price ID',
        type: 'singleLineText',
        description: 'Stripe price ID (price_xxx) used when creating the subscription.',
      },
      {
        name: 'Active',
        type: 'checkbox',
        options: { color: 'greenBright', icon: 'check' },
        description: 'Hide retired plans without deleting (preserves historical Customer.Selected Stripe Price ID values).',
      },
      {
        name: 'Description',
        type: 'multilineText',
        description: 'Short conversion copy shown in portal (e.g., "Save 16% by prepaying quarterly").',
      },
    ],
  });
  console.log(`  ✓ Created "${PLANS_TABLE_NAME}" table`);
  // Re-fetch to get the table object with field IDs
  const re = await listTables();
  const created = re.find((t) => t.name === PLANS_TABLE_NAME);
  if (!created) throw new Error('Plans table not visible after create');
  return created;
}

interface PlanSeed {
  planName: string;
  workflowKey: string;
  stripePriceId: string;
  active: boolean;
  description: string;
}

const KEYES_SEEDS: PlanSeed[] = [
  {
    planName: 'Keyes Monthly',
    workflowKey: 'B2B-Keyes',
    stripePriceId: MONTHLY_PRICE!,
    active: true,
    description: 'Pay $119/month. Cancel anytime.',
  },
  {
    planName: 'Keyes Quarterly Prepay',
    workflowKey: 'B2B-Keyes',
    stripePriceId: QUARTERLY_PRICE!,
    active: true,
    description: 'Save $19/month — pay $300 every 3 months ($100/month effective).',
  },
];

async function seedPlans(plansTable: Table) {
  const existing = await fetchAll(plansTable.id);
  const existingNames = new Set(existing.map((r) => r.fields['Plan Name'] as string));

  const toCreate = KEYES_SEEDS.filter((s) => !existingNames.has(s.planName));
  if (toCreate.length === 0) {
    console.log('  ✓ Keyes plans already seeded — skipping');
    return;
  }
  await createRecords(
    plansTable.id,
    toCreate.map((s) => ({
      fields: {
        'Plan Name': s.planName,
        'Workflow Key': s.workflowKey,
        'Stripe Price ID': s.stripePriceId,
        Active: s.active,
        Description: s.description,
      },
    })),
  );
  console.log(`  ✓ Seeded ${toCreate.length} plan(s): ${toCreate.map((s) => s.planName).join(', ')}`);
}

const CUSTOMER_FIELDS: Array<Record<string, unknown> & { name: string }> = [
  {
    name: 'Selected Stripe Price ID',
    type: 'singleLineText',
    description:
      'The Stripe price_id the customer chose at intake. Sub creation uses this directly. Captures the plan they agreed to even if the Plans row is later edited.',
  },
  {
    name: 'Selected Plan Name',
    type: 'singleLineText',
    description:
      'Snapshot of the plan name at the moment of intake. Denormalized so CSM workspace can show the human-readable label without joining Stripe Plans.',
  },
];

// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 1.2 + 1.3 — Stripe Plans table + Customer fields\n');

  console.log('Step 1: Stripe Plans table');
  const plansTable = await ensurePlansTable();

  console.log('\nStep 2: Seeding Keyes plans');
  await seedPlans(plansTable);

  console.log('\nStep 3: Customer fields');
  const tables = await listTables();
  const customers = tables.find((t) => t.name === 'Customers');
  if (!customers) throw new Error('Customers table not found');
  for (const f of CUSTOMER_FIELDS) await ensureField(customers, f);

  console.log('\n✓ Done.');
  console.log('\nPending manual cleanup (Airtable UI — Meta API does not allow field deletion):');
  console.log('  - Workflow Templates: delete "Stripe Price ID" field (no longer used; replaced by Stripe Plans table).');
  console.log('    "Trial Days" stays on Workflow Templates per Poorab decision.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
