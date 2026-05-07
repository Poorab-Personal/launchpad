/**
 * Phase 1.1 — B2B template surgery for payment + design gating.
 *
 * What this script does (idempotent):
 *  1. Adds 'Payment Setup' option to Attachment Type single-select on
 *     both Workflow Templates and Tasks tables.
 *  2. B2B-Keyes:
 *     a. Renames existing "Start Your Trial" row → "Capture Payment Method"
 *        with Attachment Type=Payment Setup, refreshed instructions.
 *     b. Adds new "Create Designs" row (Stage: Getting Started, Order: 4,
 *        Team, Has Team Review, Designer, Depends On: "Confirm Your
 *        Information, Capture Payment Method").
 *     c. Wires Depends On for: Schedule Your Onboarding Call → Capture
 *        Payment Method; Create Customer Account → Create Designs;
 *        Mark Onboarding Call Complete → Schedule Your Onboarding Call.
 *  3. B2B-BW:
 *     a. Adds new "Create Designs" row (Stage: Getting Started, Order: 3,
 *        Team, Has Team Review, Designer, Depends On: "Confirm Your
 *        Information").
 *     b. Wires Depends On for: Create Customer Account → Create Designs;
 *        Mark Onboarding Call Complete → Schedule Your Onboarding Call.
 *  4. Reads back final state and prints both workflows for verification.
 *
 * Each step checks current state and skips/no-ops when already correct.
 *
 * Usage: npx tsx scripts/phase1.1-b2b-template-surgery.ts
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

interface FieldChoice { id?: string; name: string; color?: string }
interface Field { id: string; name: string; type: string; options?: { choices?: FieldChoice[] } }
interface Table { id: string; name: string; fields: Field[] }
interface Row { id: string; fields: Record<string, unknown> }

async function listTables(): Promise<Table[]> {
  const res = await fetch(`${META}/tables`, { headers: H });
  if (!res.ok) throw new Error(`List tables failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { tables: Table[] }).tables;
}

async function fetchAll(tableId: string, filter?: string): Promise<Row[]> {
  const all: Row[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${API}/${tableId}`);
    if (filter) url.searchParams.set('filterByFormula', filter);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url.toString(), { headers: H });
    if (!res.ok) throw new Error(`Fetch ${tableId} failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { records: Row[]; offset?: string };
    all.push(...data.records);
    offset = data.offset;
  } while (offset);
  return all;
}

async function patchRecords(tableId: string, updates: Array<{ id: string; fields: Record<string, unknown> }>) {
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const res = await fetch(`${API}/${tableId}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) throw new Error(`PATCH ${tableId} failed: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 220)); // throttle
  }
}

async function createRecord(tableId: string, fields: Record<string, unknown>): Promise<Row> {
  const res = await fetch(`${API}/${tableId}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) throw new Error(`POST ${tableId} failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { records: Row[] };
  return data.records[0];
}

async function patchField(tableId: string, fieldId: string, body: Record<string, unknown>) {
  const res = await fetch(`${META}/tables/${tableId}/fields/${fieldId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH field ${fieldId} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────
// Step 1 — Add Payment Setup to Attachment Type single-selects
// ─────────────────────────────────────────────────────────────────────

async function ensurePaymentSetupOption(table: Table) {
  const field = table.fields.find((f) => f.name === 'Attachment Type');
  if (!field) throw new Error(`No Attachment Type field on ${table.name}`);
  const choices = field.options?.choices ?? [];
  if (choices.some((c) => c.name === 'Payment Setup')) {
    console.log(`  ✓ ${table.name}.Attachment Type already has 'Payment Setup'`);
    return;
  }
  throw new Error(
    `${table.name}.Attachment Type is missing the 'Payment Setup' option.\n` +
      `  Airtable's Meta API does not allow modifying single-select choices programmatically.\n` +
      `  Please add the option manually in the Airtable UI:\n` +
      `    1. Open the Airtable base\n` +
      `    2. Go to ${table.name} table\n` +
      `    3. Click into any row's Attachment Type cell\n` +
      `    4. Click 'Add option' → type 'Payment Setup' → press Enter\n` +
      `  Then re-run this script.`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step 2 + 3 — Workflow surgery
// ─────────────────────────────────────────────────────────────────────

interface RowSpec {
  workflowKey: string;
  stage: string;
  stageOrder: number;
  taskTitle: string;
  taskType: 'Client' | 'Team';
  taskOrder: number;
  visibleToClient: boolean;
  assignedRole?: string | null;
  initialStatus: 'Active' | 'Draft';
  dependsOn?: string;
  hasTeamReview?: boolean;
  attachmentType: 'None' | 'Form' | 'File Upload' | 'Embed' | 'Proof' | 'Payment Setup';
  embedUrl?: string;
  instructions?: string;
  product?: 'Core' | 'Voice' | 'Avatar';
  paymentMode?: string;
}

function specToFields(spec: RowSpec): Record<string, unknown> {
  const f: Record<string, unknown> = {
    'Workflow Key': spec.workflowKey,
    Stage: spec.stage,
    'Stage Order': spec.stageOrder,
    'Task Title': spec.taskTitle,
    'Task Type': spec.taskType,
    'Task Order': spec.taskOrder,
    'Visible To Client': spec.visibleToClient,
    'Initial Status': spec.initialStatus,
    'Attachment Type': spec.attachmentType,
    Product: spec.product ?? 'Core',
  };
  if (spec.assignedRole) f['Assigned Role'] = spec.assignedRole;
  if (spec.dependsOn !== undefined) f['Depends On'] = spec.dependsOn;
  if (spec.hasTeamReview) f['Has Team Review'] = true;
  if (spec.embedUrl) f['Embed URL'] = spec.embedUrl;
  if (spec.instructions) f.Instructions = spec.instructions;
  if (spec.paymentMode) f['Payment Mode'] = spec.paymentMode;
  return f;
}

const KEYES_CAPTURE_PAYMENT: Partial<RowSpec> = {
  taskTitle: 'Capture Payment Method',
  attachmentType: 'Payment Setup',
  embedUrl: '', // handled by portal route — Embed URL not used for Payment Setup
  instructions:
    "Add a payment method to start your free trial. You won't be charged until your onboarding call is complete.",
};

const KEYES_CREATE_DESIGNS: RowSpec = {
  workflowKey: 'B2B-Keyes',
  stage: 'Getting Started',
  stageOrder: 1,
  taskTitle: 'Create Designs',
  taskType: 'Team',
  taskOrder: 4,
  visibleToClient: false,
  assignedRole: 'Designer',
  initialStatus: 'Draft',
  dependsOn: 'Confirm Your Information, Capture Payment Method',
  hasTeamReview: true,
  attachmentType: 'None',
  instructions:
    "Create the agent's brand kit using their photo, logo, bio, and other inputs from the Customer record. Submit for senior review when ready. Customer will not see the design — once senior approves, account creation can proceed.",
  paymentMode: 'setup-intent-at-intake',
};

const BW_CREATE_DESIGNS: RowSpec = {
  workflowKey: 'B2B-BW',
  stage: 'Getting Started',
  stageOrder: 1,
  taskTitle: 'Create Designs',
  taskType: 'Team',
  taskOrder: 3,
  visibleToClient: false,
  assignedRole: 'Designer',
  initialStatus: 'Draft',
  dependsOn: 'Confirm Your Information',
  hasTeamReview: true,
  attachmentType: 'None',
  instructions:
    "Create the agent's brand kit using their photo, logo, bio, and other inputs from the Customer record. Submit for senior review when ready. Customer will not see the design — once senior approves, account creation can proceed.",
  paymentMode: 'invoice',
};

interface DependsOnUpdate {
  workflowKey: string;
  taskTitle: string;
  newDependsOn: string;
}

const DEPENDS_ON_UPDATES: DependsOnUpdate[] = [
  // B2B-Keyes
  { workflowKey: 'B2B-Keyes', taskTitle: 'Schedule Your Onboarding Call', newDependsOn: 'Capture Payment Method' },
  { workflowKey: 'B2B-Keyes', taskTitle: 'Create Customer Account', newDependsOn: 'Create Designs' },
  { workflowKey: 'B2B-Keyes', taskTitle: 'Mark Onboarding Call Complete', newDependsOn: 'Schedule Your Onboarding Call' },
  // B2B-BW
  { workflowKey: 'B2B-BW', taskTitle: 'Create Customer Account', newDependsOn: 'Create Designs' },
  { workflowKey: 'B2B-BW', taskTitle: 'Mark Onboarding Call Complete', newDependsOn: 'Schedule Your Onboarding Call' },
];

async function surgeryKeyes(wfTemplatesTableId: string) {
  console.log('\nB2B-Keyes:');
  const rows = await fetchAll(
    wfTemplatesTableId,
    `{Workflow Key}='B2B-Keyes'`,
  );

  // 2a. Rename Start Your Trial → Capture Payment Method
  const startTrial = rows.find((r) => r.fields['Task Title'] === 'Start Your Trial');
  const alreadyCapture = rows.find((r) => r.fields['Task Title'] === 'Capture Payment Method');
  if (alreadyCapture) {
    console.log("  ✓ 'Capture Payment Method' already exists — skipping rename");
  } else if (startTrial) {
    const update: Record<string, unknown> = {
      'Task Title': KEYES_CAPTURE_PAYMENT.taskTitle,
      'Attachment Type': KEYES_CAPTURE_PAYMENT.attachmentType,
      Instructions: KEYES_CAPTURE_PAYMENT.instructions,
    };
    await patchRecords(wfTemplatesTableId, [{ id: startTrial.id, fields: update }]);
    console.log(`  ✓ Renamed 'Start Your Trial' → 'Capture Payment Method' (attachment=Payment Setup)`);
  } else {
    console.log("  ⚠ Neither 'Start Your Trial' nor 'Capture Payment Method' found — skipping");
  }

  // 2b. Add Create Designs row
  const existingDesigns = rows.find((r) => r.fields['Task Title'] === 'Create Designs');
  if (existingDesigns) {
    console.log("  ✓ 'Create Designs' row already exists — skipping create");
  } else {
    await createRecord(wfTemplatesTableId, specToFields(KEYES_CREATE_DESIGNS));
    console.log(`  ✓ Created 'Create Designs' row (Stage 1/Order 4, Designer, Has Team Review)`);
  }
}

async function surgeryBW(wfTemplatesTableId: string) {
  console.log('\nB2B-BW:');
  const rows = await fetchAll(
    wfTemplatesTableId,
    `{Workflow Key}='B2B-BW'`,
  );

  const existingDesigns = rows.find((r) => r.fields['Task Title'] === 'Create Designs');
  if (existingDesigns) {
    console.log("  ✓ 'Create Designs' row already exists — skipping create");
  } else {
    await createRecord(wfTemplatesTableId, specToFields(BW_CREATE_DESIGNS));
    console.log(`  ✓ Created 'Create Designs' row (Stage 1/Order 3, Designer, Has Team Review)`);
  }
}

async function applyDependsOnUpdates(wfTemplatesTableId: string) {
  console.log('\nDepends On wiring:');

  // Re-fetch after creates so we see new rows if any
  const allRows = await fetchAll(wfTemplatesTableId);

  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let skipped = 0;

  for (const u of DEPENDS_ON_UPDATES) {
    const row = allRows.find(
      (r) => r.fields['Workflow Key'] === u.workflowKey && r.fields['Task Title'] === u.taskTitle,
    );
    if (!row) {
      console.log(`  ⚠ ${u.workflowKey}.${u.taskTitle} not found — skipping`);
      continue;
    }
    const current = (row.fields['Depends On'] as string) ?? '';
    if (current === u.newDependsOn) {
      skipped++;
      continue;
    }
    updates.push({ id: row.id, fields: { 'Depends On': u.newDependsOn } });
    console.log(`  → ${u.workflowKey}.${u.taskTitle}: "${current}" → "${u.newDependsOn}"`);
  }

  if (skipped > 0) console.log(`  ✓ ${skipped} row(s) already correct`);

  if (updates.length > 0) {
    await patchRecords(wfTemplatesTableId, updates);
    console.log(`  ✓ Updated ${updates.length} row(s)`);
  } else {
    console.log('  Nothing to update.');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Step 4 — Read back & print
// ─────────────────────────────────────────────────────────────────────

async function printWorkflows(wfTemplatesTableId: string) {
  console.log('\n──── Final state ────');
  const allRows = await fetchAll(wfTemplatesTableId);

  for (const wf of ['B2B-Keyes', 'B2B-BW']) {
    const rows = allRows
      .filter((r) => r.fields['Workflow Key'] === wf)
      .sort((a, b) => {
        const sa = (a.fields['Stage Order'] as number) ?? 99;
        const sb = (b.fields['Stage Order'] as number) ?? 99;
        if (sa !== sb) return sa - sb;
        return ((a.fields['Task Order'] as number) ?? 99) - ((b.fields['Task Order'] as number) ?? 99);
      });
    console.log(`\n=== ${wf} (${rows.length} tasks) ===`);
    console.log(
      `${'Stage'.padEnd(24)} ${'#'.padStart(3)} ${'Task Title'.padEnd(34)} ${'Type'.padEnd(7)} ${'Vis'.padEnd(4)} ${'Init'.padEnd(7)} ${'TR'.padEnd(3)} ${'Attach'.padEnd(14)} Depends On`,
    );
    console.log('-'.repeat(150));
    for (const r of rows) {
      const f = r.fields as Record<string, unknown>;
      console.log(
        `${(f.Stage as string ?? '').padEnd(24)} ${String(f['Task Order'] ?? '').padStart(3)} ${(f['Task Title'] as string ?? '').slice(0, 34).padEnd(34)} ${(f['Task Type'] as string ?? '').slice(0, 7).padEnd(7)} ${(f['Visible To Client'] ? 'Y' : '-').padEnd(4)} ${(f['Initial Status'] as string ?? '').slice(0, 7).padEnd(7)} ${(f['Has Team Review'] ? '✓' : '-').padEnd(3)} ${(f['Attachment Type'] as string ?? '').slice(0, 14).padEnd(14)} ${(f['Depends On'] as string) ?? ''}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 1.1 — B2B template surgery\n');

  let tables = await listTables();
  const wfTemplates = tables.find((t) => t.name === 'Workflow Templates');
  const tasks = tables.find((t) => t.name === 'Tasks');
  if (!wfTemplates) throw new Error('Workflow Templates table not found');
  if (!tasks) throw new Error('Tasks table not found');

  console.log("Step 1 — Adding 'Payment Setup' to Attachment Type single-selects:");
  await ensurePaymentSetupOption(wfTemplates);
  await ensurePaymentSetupOption(tasks);

  // Re-fetch after option add (defensive)
  tables = await listTables();
  const wfTemplatesAfter = tables.find((t) => t.name === 'Workflow Templates')!;

  console.log("\nStep 2 — B2B-Keyes:");
  await surgeryKeyes(wfTemplatesAfter.id);

  console.log("\nStep 3 — B2B-BW:");
  await surgeryBW(wfTemplatesAfter.id);

  await applyDependsOnUpdates(wfTemplatesAfter.id);

  await printWorkflows(wfTemplatesAfter.id);

  console.log('\n✓ Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
