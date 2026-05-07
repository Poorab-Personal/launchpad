/**
 * Phase 0 — Additive schema migration for payment-mode + drop-off handling.
 *
 * Adds new fields to Workflow Templates, Customers, Tasks. Idempotent
 * (skips fields that already exist). Does NOT delete legacy fields —
 * see scripts/phase0-cleanup-legacy-reminder-fields.ts for that.
 *
 * After running this, populate Stripe Price ID + Trial Days manually in
 * Airtable on the B2B-Keyes Workflow Templates rows before Phase 1 launch.
 *
 * Usage: npx tsx scripts/phase0-payment-mode-fields.ts
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
const API = `https://api.airtable.com/v0/${BASE_ID}`;
const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

interface Field {
  id: string;
  name: string;
  type: string;
  options?: Record<string, unknown>;
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

async function addField(tableId: string, field: Record<string, unknown>) {
  const res = await fetch(`${META}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(field),
  });
  if (!res.ok) {
    throw new Error(`Add field "${field.name}" failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function ensureField(table: Table, field: Record<string, unknown> & { name: string }) {
  if (table.fields.some((f) => f.name === field.name)) {
    console.log(`  ✓ "${field.name}" exists — skipping`);
    return;
  }
  await addField(table.id, field);
  console.log(`  ✓ Added "${field.name}" (${field.type})`);
}

// ─────────────────────────────────────────────────────────────────────
// Field definitions
// ─────────────────────────────────────────────────────────────────────

const WORKFLOW_TEMPLATE_FIELDS: Array<Record<string, unknown> & { name: string }> = [
  {
    name: 'Payment Mode',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'pre-paid' },
        { name: 'setup-intent-at-intake' },
        { name: 'invoice' },
        { name: 'none' },
      ],
    },
    description:
      'Per-workflow payment behavior. Drives whether Capture Payment Method task is generated and when sub creation fires.',
  },
  {
    name: 'Stripe Price ID',
    type: 'singleLineText',
    description:
      'Stripe price ID used when creating the subscription. Required when Payment Mode = setup-intent-at-intake.',
  },
  {
    name: 'Trial Days',
    type: 'number',
    options: { precision: 0 },
    description:
      'Days of trial when creating the subscription. Required when Payment Mode = setup-intent-at-intake.',
  },
];

const CUSTOMER_FIELDS: Array<Record<string, unknown> & { name: string }> = [
  {
    name: 'At Risk',
    type: 'checkbox',
    options: { color: 'redBright', icon: 'flag' },
    description:
      'Set by drop-off reminder cron after 3rd reminder, by CSM action, or manual flag. Cleared by webhooks (Stripe, Calendly, form, design approval) or CSM action.',
  },
  {
    name: 'At Risk Reason',
    type: 'singleSelect',
    options: {
      choices: [
        { name: 'No CC' },
        { name: 'No Booking' },
        { name: 'No Approval' },
        { name: 'No Form' },
        { name: 'CSM Flagged' },
      ],
    },
    description: 'Reason for At Risk flag. Cleared when At Risk goes false.',
  },
  {
    name: 'Stripe Customer ID',
    type: 'singleLineText',
    description:
      'Stripe customer ID. Created at Customer record creation for setup-intent-at-intake workflows; lazily backfilled from Stripe Payment ID for pre-paid D2C; never set for invoice/none.',
  },
  {
    name: 'Stripe Subscription ID',
    type: 'singleLineText',
    description:
      'Stripe subscription ID. Set when subscription is created (triggered off Calls.Status = Completed AND Type = Onboarding for setup-intent-at-intake workflows).',
  },
];

const TASK_FIELDS: Array<Record<string, unknown> & { name: string }> = [
  {
    name: 'Last Reminder At',
    type: 'dateTime',
    options: {
      dateFormat: { name: 'iso' },
      timeFormat: { name: '24hour' },
      timeZone: 'client',
    },
    description:
      'When the drop-off reminder cron last sent a reminder for this task. Reminder number is computed as floor((now - Activated At) / 4d).',
  },
];

// ─────────────────────────────────────────────────────────────────────
// Populate Payment Mode on existing rows
// ─────────────────────────────────────────────────────────────────────

const PAYMENT_MODE_BY_WORKFLOW_KEY: Record<string, string> = {
  'D2C-Standard': 'pre-paid',
  'B2B-Keyes': 'setup-intent-at-intake',
  'B2B-BW': 'invoice',
};

async function populatePaymentMode(workflowTemplatesTableId: string) {
  console.log('\nPopulating Payment Mode on existing Workflow Templates rows...');

  const all: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${API}/${workflowTemplatesTableId}`);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers: H });
    if (!res.ok) throw new Error(`List records failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      records: Array<{ id: string; fields: Record<string, unknown> }>;
      offset?: string;
    };
    all.push(...data.records);
    offset = data.offset;
  } while (offset);

  console.log(`  Found ${all.length} template rows`);

  // Group by workflow key, decide what to update
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let skippedAlreadySet = 0;
  let skippedUnknownKey = 0;

  for (const row of all) {
    const key = row.fields['Workflow Key'] as string | undefined;
    const existing = row.fields['Payment Mode'] as string | undefined;
    if (existing) {
      skippedAlreadySet++;
      continue;
    }
    const mode = key ? PAYMENT_MODE_BY_WORKFLOW_KEY[key] : undefined;
    if (!mode) {
      skippedUnknownKey++;
      continue;
    }
    updates.push({ id: row.id, fields: { 'Payment Mode': mode } });
  }

  console.log(
    `  ${updates.length} rows to update, ${skippedAlreadySet} already set, ${skippedUnknownKey} unknown key`,
  );

  if (updates.length === 0) {
    console.log('  Nothing to update.');
    return;
  }

  // Airtable PATCH supports up to 10 records per call
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const res = await fetch(`${API}/${workflowTemplatesTableId}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      throw new Error(`PATCH batch failed: ${res.status} ${await res.text()}`);
    }
    // Throttle for the 5 req/s base limit
    await new Promise((r) => setTimeout(r, 220));
  }

  console.log(`  ✓ Updated ${updates.length} rows`);
}

// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 0 — Adding payment-mode + drop-off fields\n');

  const tables = await listTables();
  const wfTemplates = tables.find((t) => t.name === 'Workflow Templates');
  const customers = tables.find((t) => t.name === 'Customers');
  const tasks = tables.find((t) => t.name === 'Tasks');

  if (!wfTemplates) throw new Error('Workflow Templates table not found');
  if (!customers) throw new Error('Customers table not found');
  if (!tasks) throw new Error('Tasks table not found');

  console.log('Workflow Templates:');
  for (const f of WORKFLOW_TEMPLATE_FIELDS) await ensureField(wfTemplates, f);

  console.log('\nCustomers:');
  for (const f of CUSTOMER_FIELDS) await ensureField(customers, f);

  console.log('\nTasks:');
  for (const f of TASK_FIELDS) await ensureField(tasks, f);

  // Re-fetch Workflow Templates to confirm Payment Mode field exists before populating
  const tablesAfter = await listTables();
  const wfTemplatesAfter = tablesAfter.find((t) => t.name === 'Workflow Templates')!;
  const hasPaymentMode = wfTemplatesAfter.fields.some((f) => f.name === 'Payment Mode');
  if (!hasPaymentMode) {
    throw new Error('Payment Mode field not visible after add — aborting populate step');
  }

  await populatePaymentMode(wfTemplatesAfter.id);

  console.log('\n✓ Done.');
  console.log('\nNext steps:');
  console.log('  1. Manually set Stripe Price ID + Trial Days on B2B-Keyes Workflow Templates rows in Airtable.');
  console.log('  2. Update TypeScript types + mappers (see plan Phase 0 checklist).');
  console.log('  3. Run scripts/phase0-cleanup-legacy-reminder-fields.ts to remove dead fields.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
