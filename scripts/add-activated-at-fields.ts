/**
 * One-off migration: add Activated At + Days Active fields to Tasks table.
 *
 * - Activated At (dateTime) — set when a task transitions to Active for the first time
 * - Days Active (formula)  — DATETIME_DIFF(NOW(), {Activated At}, 'days') for in-flight tasks
 *
 * Idempotent: skips fields that already exist.
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

async function getTasksTable() {
  const res = await fetch(`${META}/tables`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!res.ok) throw new Error(`List tables failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const table = data.tables.find((t: { name: string }) => t.name === 'Tasks');
  if (!table) throw new Error('Tasks table not found');
  return table;
}

async function addField(tableId: string, field: Record<string, unknown>) {
  const res = await fetch(`${META}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(field),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Add field "${field.name}" failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const table = await getTasksTable();
  const existing = new Set(table.fields.map((f: { name: string }) => f.name));

  if (existing.has('Activated At')) {
    console.log('✓ "Activated At" already exists — skipping');
  } else {
    await addField(table.id, {
      name: 'Activated At',
      type: 'dateTime',
      options: {
        dateFormat: { name: 'iso' },
        timeFormat: { name: '24hour' },
        timeZone: 'client',
      },
      description:
        'Timestamp when this task first transitioned to Active. Set once; not updated on subsequent status changes.',
    });
    console.log('✓ Added "Activated At" (dateTime)');
  }

  if (existing.has('Days Active')) {
    console.log('✓ "Days Active" already exists — skipping');
  } else {
    await addField(table.id, {
      name: 'Days Active',
      type: 'formula',
      options: {
        formula:
          "IF(OR({Status}='Active',{Status}='In Review'), DATETIME_DIFF(NOW(),{Activated At},'days'), BLANK())",
      },
      description:
        'Days since this task became Active. Blank for Draft/Completed/Rejected. Counts continuously through In Review.',
    });
    console.log('✓ Added "Days Active" (formula)');
  }

  console.log('\nDone. Verify in Airtable → Tasks table.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
