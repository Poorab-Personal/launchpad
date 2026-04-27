/**
 * Full Airtable setup: creates tables, fields, and seeds workflow templates.
 *
 * Usage: npx tsx scripts/setup-airtable.ts
 *
 * Requires AIRTABLE_PAT and AIRTABLE_BASE_ID in .env.local
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;
const META_URL = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`;
const DATA_URL = `https://api.airtable.com/v0/${BASE_ID}`;

if (!PAT || !BASE_ID) {
  console.error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID in .env.local');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${PAT}`,
  'Content-Type': 'application/json',
};

async function createTable(name: string, fields: unknown[]): Promise<{ id: string; name: string }> {
  console.log(`Creating table: ${name}...`);
  const res = await fetch(META_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create table "${name}" (${res.status}): ${body}`);
  }
  const data = await res.json();
  console.log(`  Created: ${data.id}`);
  return { id: data.id, name: data.name };
}

async function batchCreate(table: string, records: Array<{ fields: Record<string, unknown> }>) {
  const all = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const res = await fetch(`${DATA_URL}/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to seed "${table}" (${res.status}): ${body}`);
    }
    const data = await res.json();
    all.push(...data.records);
  }
  return all;
}

async function main() {
  console.log('\n=== LaunchPad Airtable Setup ===\n');

  // 1. Create Customers table
  const customers = await createTable('Customers', [
    { name: 'Name', type: 'singleLineText' },
    {
      name: 'Channel',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'D2C', color: 'blueLight2' },
          { name: 'B2B', color: 'greenLight2' },
        ],
      },
    },
    { name: 'Type', type: 'singleLineText' },
    { name: 'Current Stage', type: 'singleLineText' },
    {
      name: 'Stage Entered At',
      type: 'dateTime',
      options: {
        dateFormat: { name: 'iso' },
        timeFormat: { name: '24hour' },
        timeZone: 'America/New_York',
      },
    },
    { name: 'Contact Email', type: 'email' },
  ]);

  // 2. Create Workflow Templates table
  await createTable('Workflow Templates', [
    { name: 'Workflow Key', type: 'singleLineText' },
    { name: 'Stage', type: 'singleLineText' },
    { name: 'Stage Order', type: 'number', options: { precision: 0 } },
    { name: 'Task Title', type: 'singleLineText' },
    {
      name: 'Task Type',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'Client', color: 'blueLight2' },
          { name: 'Team', color: 'purpleLight2' },
        ],
      },
    },
    { name: 'Task Order', type: 'number', options: { precision: 0 } },
    { name: 'Visible To Client', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
    {
      name: 'Initial Status',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'Active', color: 'greenLight2' },
          { name: 'Draft', color: 'grayLight2' },
        ],
      },
    },
    { name: 'Depends On', type: 'singleLineText' },
    {
      name: 'Attachment Type',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'None', color: 'grayLight2' },
          { name: 'Form', color: 'blueLight2' },
          { name: 'File Upload', color: 'cyanLight2' },
          { name: 'Embed', color: 'purpleLight2' },
          { name: 'Proof', color: 'yellowLight2' },
        ],
      },
    },
    { name: 'Instructions', type: 'multilineText' },
  ]);

  // 3. Create Tasks table (with link to Customers)
  await createTable('Tasks', [
    { name: 'Task Name', type: 'singleLineText' },
    {
      name: 'Customer',
      type: 'multipleRecordLinks',
      options: { linkedTableId: customers.id },
    },
    {
      name: 'Task Type',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'Client', color: 'blueLight2' },
          { name: 'Team', color: 'purpleLight2' },
        ],
      },
    },
    { name: 'Stage', type: 'singleLineText' },
    {
      name: 'Status',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'Draft', color: 'grayLight2' },
          { name: 'Active', color: 'blueLight2' },
          { name: 'Completed', color: 'greenLight2' },
        ],
      },
    },
    { name: 'Task Order', type: 'number', options: { precision: 0 } },
    { name: 'Visible To Client', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
    { name: 'Depends On', type: 'singleLineText' },
    {
      name: 'Attachment Type',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'None', color: 'grayLight2' },
          { name: 'Form', color: 'blueLight2' },
          { name: 'File Upload', color: 'cyanLight2' },
          { name: 'Embed', color: 'purpleLight2' },
          { name: 'Proof', color: 'yellowLight2' },
        ],
      },
    },
    { name: 'Instructions', type: 'multilineText' },
  ]);

  // 4. Seed Workflow Templates
  console.log('\nSeeding Workflow Templates...');
  const templateData = [
    // D2C-Standard (3 stages, 5 tasks)
    { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Complete Intake Form', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'Tell us about your business.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Upload Brand Assets', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'File Upload', Instructions: 'Upload your logo and headshot.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 2, 'Task Title': 'Schedule Onboarding Call', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Upload Brand Assets', 'Attachment Type': 'Embed', Instructions: 'Pick a time for your onboarding call.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Get Started', 'Stage Order': 3, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Onboarding Call', 'Attachment Type': 'Embed', Instructions: 'Watch this video before your call.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Get Started', 'Stage Order': 3, 'Task Title': 'Sign In & Explore', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Onboarding Call', 'Attachment Type': 'None', Instructions: 'Log in to app.rejig.ai and look around.' },

    // B2B-Keyes (2 stages, 4 tasks)
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Confirm Your Information', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'Review your info and update if needed.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Schedule Onboarding Call', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Embed', Instructions: 'Pick a time for your onboarding call.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Get Started', 'Stage Order': 2, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Onboarding Call', 'Attachment Type': 'Embed', Instructions: 'Watch this video before your call.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Get Started', 'Stage Order': 2, 'Task Title': 'Sign In & Explore', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Watch Setup Video', 'Attachment Type': 'None', Instructions: 'Log in and explore the platform.' },
  ];

  const records = templateData.map((fields) => ({ fields }));
  const created = await batchCreate('Workflow Templates', records);
  console.log(`  Seeded ${created.length} workflow templates.`);

  console.log('\n=== Setup complete! ===');
  console.log(`\nCustomers table ID: ${customers.id}`);
  console.log('\nNext steps:');
  console.log('1. Start the dev server: npm run dev');
  console.log('2. Create a test customer: curl -X POST http://localhost:3000/api/customers -H "Content-Type: application/json" -d \'{"name":"Test Agent","channel":"D2C","type":"Standard","email":"test@example.com"}\'');
  console.log('3. Check the admin view: http://localhost:3000/admin');
  console.log('4. Check the portal: http://localhost:3000/r/{id-from-step-2}');
}

main().catch((err) => {
  console.error('\nSetup failed:', err);
  process.exit(1);
});
