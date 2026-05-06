/**
 * One-off setup: create Calls table for tracking CSM↔customer calls.
 *
 * Why:
 *   The legacy `Customer.Call Date` field was a single dateTime that got
 *   clobbered every time any "Schedule" task fired (onboarding + check-in 1
 *   + check-in 2 all wrote to it). This table gives us one row per call,
 *   typed by purpose, with notes/recording/CSM/idempotency columns so the
 *   webhook can upsert and the CSM workspace can render history + upcoming.
 *
 * Fields (created in this order — first text field becomes the primary):
 *   - Customer (multipleRecordLinks → Customers)
 *   - Type (singleSelect: Onboarding | Check-In 1 | Check-In 2 | Ad-hoc)
 *   - Scheduled Date (dateTime)
 *   - Status (singleSelect: Scheduled | Completed | No Show | Rescheduled | Canceled)
 *   - CSM (multipleRecordLinks → Team Members)
 *   - Notes (multilineText)
 *   - Recording URL (url)
 *   - Calendly Event UUID (singleLineText) — webhook idempotency key
 *
 * Note: createdTime / lastModifiedTime CANNOT be created via the Meta API
 * (returns UNSUPPORTED_FIELD_TYPE_FOR_CREATE). Airtable always exposes the
 * underlying createdTime as `record.createdTime` in API responses, so a
 * `Created At` field is redundant. If you want a `Last Modified` field
 * surfaced for views/sorting, add it manually in the Airtable UI:
 *   Field name: Last Modified
 *   Type:       Last modified time
 *   (default options)
 *
 * Idempotent: if Calls table exists, just verifies each field is present
 * and adds any missing ones.
 *
 * Meta API quirks (learned the hard way in this codebase):
 *   - On CREATE, multipleRecordLinks accepts ONLY `linkedTableId`.
 *     `isReversed` and `prefersSingleRecordLink` are rejected.
 *   - createdTime / lastModifiedTime cannot be created via Meta API at all.
 *
 * Usage: npx tsx scripts/setup-calls-table.ts
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

const auth = { Authorization: `Bearer ${PAT}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

interface AirtableField {
  id: string;
  name: string;
  type: string;
}

interface AirtableTable {
  id: string;
  name: string;
  fields: AirtableField[];
}

async function getTables(): Promise<AirtableTable[]> {
  const res = await fetch(`${META}/tables`, { headers: auth });
  if (!res.ok) throw new Error(`List tables: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { tables: AirtableTable[] }).tables;
}

async function createTable(name: string, fields: Record<string, unknown>[]): Promise<AirtableTable> {
  const res = await fetch(`${META}/tables`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ name, fields }),
  });
  if (!res.ok) throw new Error(`Create table ${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function addField(tableId: string, field: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${META}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify(field),
  });
  if (!res.ok) throw new Error(`Add field "${field.name}": ${res.status} ${await res.text()}`);
}

// ─── Field defs ─────────────────────────────────────────────────────

function buildFieldDefs(customersTableId: string, teamMembersTableId: string) {
  return {
    // Primary text field — used as the row label in Airtable views.
    // We use a placeholder primary that's just a calendly UUID; real labelling
    // happens via formulas/views. Keeping it as a plain text "Title" so users
    // can type something custom for ad-hoc calls if needed.
    'Title': { name: 'Title', type: 'singleLineText' as const },
    'Customer': {
      name: 'Customer',
      type: 'multipleRecordLinks' as const,
      options: { linkedTableId: customersTableId },
      description: 'Which customer this call is with.',
    },
    'Type': {
      name: 'Type',
      type: 'singleSelect' as const,
      options: {
        choices: [
          { name: 'Onboarding', color: 'blueLight2' },
          { name: 'Check-In 1', color: 'greenLight2' },
          { name: 'Check-In 2', color: 'tealLight2' },
          { name: 'Ad-hoc', color: 'grayLight2' },
        ],
      },
      description: 'Purpose of this call.',
    },
    'Scheduled Date': {
      name: 'Scheduled Date',
      type: 'dateTime' as const,
      options: {
        dateFormat: { name: 'iso' },
        timeFormat: { name: '24hour' },
        timeZone: 'America/New_York',
      },
      description: 'When the call is scheduled (start time).',
    },
    'Status': {
      name: 'Status',
      type: 'singleSelect' as const,
      options: {
        choices: [
          { name: 'Scheduled', color: 'blueLight2' },
          { name: 'Completed', color: 'greenLight2' },
          { name: 'No Show', color: 'redLight2' },
          { name: 'Rescheduled', color: 'yellowLight2' },
          { name: 'Canceled', color: 'grayLight2' },
        ],
      },
    },
    'CSM': {
      name: 'CSM',
      type: 'multipleRecordLinks' as const,
      options: { linkedTableId: teamMembersTableId },
      description: 'CSM who owns this call.',
    },
    'Notes': {
      name: 'Notes',
      type: 'multilineText' as const,
      description: 'Free-form CSM notes for this call.',
    },
    'Recording URL': {
      name: 'Recording URL',
      type: 'url' as const,
      description: 'Link to Zoom/Loom recording, if any.',
    },
    'Calendly Event UUID': {
      name: 'Calendly Event UUID',
      type: 'singleLineText' as const,
      description: 'UUID extracted from Calendly event URI. Used for webhook idempotency — one row per Calendly event.',
    },
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const tables = await getTables();
  const customers = tables.find((t) => t.name === 'Customers');
  const teamMembers = tables.find((t) => t.name === 'Team Members');

  if (!customers) throw new Error('Customers table not found — run setup-production.ts first.');
  if (!teamMembers) throw new Error('Team Members table not found — run setup-production.ts first.');

  const fieldDefs = buildFieldDefs(customers.id, teamMembers.id);

  // Order matters at create time — first field becomes the primary field.
  const orderedFieldNames: Array<keyof ReturnType<typeof buildFieldDefs>> = [
    'Title',
    'Customer',
    'Type',
    'Scheduled Date',
    'Status',
    'CSM',
    'Notes',
    'Recording URL',
    'Calendly Event UUID',
  ];

  let calls = tables.find((t) => t.name === 'Calls');

  if (!calls) {
    console.log('Creating Calls table...');
    const created = await createTable(
      'Calls',
      orderedFieldNames.map((n) => fieldDefs[n] as Record<string, unknown>),
    );
    calls = created;
    console.log(`✓ Created Calls table (id: ${created.id})`);
  } else {
    console.log(`✓ Calls table already exists (id: ${calls.id}) — verifying fields...`);

    const existingFieldNames = new Set(calls.fields.map((f) => f.name));
    let added = 0;
    for (const fieldName of orderedFieldNames) {
      if (existingFieldNames.has(fieldName)) continue;
      console.log(`  + Adding missing field: ${fieldName}`);
      await addField(calls.id, fieldDefs[fieldName] as Record<string, unknown>);
      added++;
    }
    if (added === 0) {
      console.log('  All expected fields present.');
    } else {
      console.log(`  Added ${added} missing field(s).`);
    }
  }

  console.log('\n--- Done ---');
  console.log(`Calls table id: ${calls.id}`);
  console.log('\nManual step (optional, Meta API limitation):');
  console.log('  Add a "Last Modified" lastModifiedTime field via the Airtable UI');
  console.log('  if you want to sort/filter by edit time. Created time is always');
  console.log('  available via record.createdTime in the API.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
