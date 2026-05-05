/**
 * One-off setup: create Settings table for environment config (e.g., portal base URL).
 *
 * Steps:
 *  1. Create Settings table with `Name` (primary) + `Portal Base URL` (url) fields
 *  2. Insert "Production" row pointing at the current Vercel URL
 *  3. Add Environment (multipleRecordLinks → Settings) to Customers
 *  4. Add Portal Base URL (lookup → Environment → Portal Base URL) to Customers
 *  5. Backfill every existing Customer with Environment = Production
 *
 * Idempotent: skips anything that already exists.
 *
 * After this runs, the user manually adds the Portal URL formula on Customers:
 *   ARRAYJOIN({Portal Base URL}, "") & "/r/" & RECORD_ID()
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;

if (!PAT || !BASE_ID) {
  console.error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID in .env.local');
  process.exit(1);
}

const META = `https://api.airtable.com/v0/meta/bases/${BASE_ID}`;
const DATA = `https://api.airtable.com/v0/${BASE_ID}`;

const PROD_URL = 'https://launchpad-indol-ten.vercel.app';

const auth = { Authorization: `Bearer ${PAT}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

async function getTables() {
  const res = await fetch(`${META}/tables`, { headers: auth });
  if (!res.ok) throw new Error(`List tables: ${res.status} ${await res.text()}`);
  return (await res.json()).tables as Array<{
    id: string;
    name: string;
    fields: Array<{ id: string; name: string; type: string }>;
  }>;
}

async function createTable(name: string, fields: Record<string, unknown>[]) {
  const res = await fetch(`${META}/tables`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ name, fields }),
  });
  if (!res.ok) throw new Error(`Create table ${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function addField(tableId: string, field: Record<string, unknown>) {
  const res = await fetch(`${META}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify(field),
  });
  if (!res.ok) throw new Error(`Add field ${field.name}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createRecord(tableName: string, fields: Record<string, unknown>) {
  const res = await fetch(`${DATA}/${encodeURIComponent(tableName)}`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Create record: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listRecords(tableName: string) {
  const all: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${DATA}/${encodeURIComponent(tableName)}`);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers: auth });
    if (!res.ok) throw new Error(`List ${tableName}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...data.records);
    offset = data.offset;
  } while (offset);
  return all;
}

async function patchRecords(
  tableName: string,
  records: Array<{ id: string; fields: Record<string, unknown> }>,
) {
  // Airtable: max 10 records per PATCH
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetch(`${DATA}/${encodeURIComponent(tableName)}`, {
      method: 'PATCH',
      headers: jsonAuth,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) throw new Error(`Patch batch: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const tables = await getTables();
  const settings = tables.find((t) => t.name === 'Settings');
  const customers = tables.find((t) => t.name === 'Customers');
  if (!customers) throw new Error('Customers table not found');

  // ── 1. Create Settings table if missing ─────────────────────────────
  let settingsId: string;
  if (settings) {
    console.log('✓ Settings table already exists');
    settingsId = settings.id;
  } else {
    const created = await createTable('Settings', [
      { name: 'Name', type: 'singleLineText' },
      {
        name: 'Portal Base URL',
        type: 'url',
        description: 'Base URL of the customer portal (no trailing slash). Used to build per-customer portal links.',
      },
    ]);
    settingsId = created.id;
    console.log('✓ Created Settings table');
  }

  // ── 2. Create Production row if missing ─────────────────────────────
  const settingsRecords = await listRecords('Settings');
  const prodRow = settingsRecords.find((r) => r.fields.Name === 'Production');
  let prodId: string;
  if (prodRow) {
    console.log('✓ Production row already exists');
    prodId = prodRow.id;
  } else {
    const created = await createRecord('Settings', {
      Name: 'Production',
      'Portal Base URL': PROD_URL,
    });
    prodId = created.id;
    console.log(`✓ Created Production row → ${PROD_URL}`);
  }

  // ── 3. Add Environment linked-record field to Customers ─────────────
  const refreshed = await getTables();
  const cust = refreshed.find((t) => t.name === 'Customers')!;
  const hasEnv = cust.fields.find((f) => f.name === 'Environment');
  if (hasEnv) {
    console.log('✓ Customers.Environment already exists');
  } else {
    await addField(cust.id, {
      name: 'Environment',
      type: 'multipleRecordLinks',
      options: {
        linkedTableId: settingsId,
      },
      description: 'Which environment config this customer belongs to (e.g., Production).',
    });
    console.log('✓ Added Customers.Environment (link → Settings)');
  }

  // ── 4. Lookup field — can't be created via Meta API ─────────────────
  // (Airtable docs: "Creating multipleLookupValues fields is not supported")
  // User will add this manually after the script.

  // ── 5. Backfill existing Customers to point at Production ───────────
  const customerRecords = await listRecords('Customers');
  const needsBackfill = customerRecords.filter((r) => {
    const env = r.fields.Environment as Array<{ id: string }> | undefined;
    return !env || env.length === 0;
  });
  if (needsBackfill.length === 0) {
    console.log('✓ All customers already linked to an Environment');
  } else {
    const patches = needsBackfill.map((r) => ({
      id: r.id,
      fields: { Environment: [prodId] },
    }));
    await patchRecords('Customers', patches);
    console.log(`✓ Backfilled ${needsBackfill.length} customers → Production`);
  }

  console.log('\n--- Done ---');
  console.log('\nManual steps remaining (Meta API does not support these field types):');
  console.log('\n1. Add lookup field on Customers:');
  console.log('     Name:           Portal Base URL');
  console.log('     Type:           Lookup');
  console.log('     Linked field:   Environment');
  console.log('     Field to look up: Portal Base URL  (from Settings)');
  console.log('\n2. Add formula field on Customers:');
  console.log('     Name:    Portal URL');
  console.log('     Type:    Formula');
  console.log('     Formula: ARRAYJOIN({Portal Base URL}, "") & "/r/" & RECORD_ID()');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
