/**
 * Production Airtable setup: creates all 7 tables with full schema and seeds data.
 *
 * Usage: npx tsx scripts/setup-production.ts
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

// ─── Helpers ────────────────────────────────────────────────────────

async function listTables(): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(META_URL, { headers });
  const data = await res.json();
  return data.tables.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }));
}

async function deleteTable(id: string, name: string) {
  console.log(`  Deleting: ${name} (${id})`);
  const res = await fetch(`${META_URL}/${id}`, { method: 'DELETE', headers });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`  Warning: Could not delete ${name}: ${body}`);
  }
}

async function createTable(name: string, fields: unknown[]): Promise<string> {
  console.log(`  Creating: ${name} (${fields.length} fields)...`);
  const res = await fetch(META_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create "${name}" (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.id;
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

// ─── Single select helper ───────────────────────────────────────────

function ss(name: string, choices: string[], colors?: string[]) {
  const defaultColors = ['blueLight2', 'greenLight2', 'purpleLight2', 'redLight2', 'yellowLight2', 'cyanLight2', 'grayLight2', 'pinkLight2', 'orangeLight2', 'tealLight2'];
  return {
    name,
    type: 'singleSelect',
    options: {
      choices: choices.map((c, i) => ({
        name: c,
        color: colors?.[i] ?? defaultColors[i % defaultColors.length],
      })),
    },
  };
}

function ms(name: string, choices: string[]) {
  const defaultColors = ['blueLight2', 'greenLight2', 'purpleLight2', 'redLight2', 'yellowLight2'];
  return {
    name,
    type: 'multipleSelects',
    options: {
      choices: choices.map((c, i) => ({
        name: c,
        color: defaultColors[i % defaultColors.length],
      })),
    },
  };
}

function cb(name: string) {
  return { name, type: 'checkbox', options: { icon: 'check', color: 'greenBright' } };
}

function num(name: string) {
  return { name, type: 'number', options: { precision: 0 } };
}

function dt(name: string) {
  return {
    name,
    type: 'dateTime',
    options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/New_York' },
  };
}

function link(name: string, tableId: string) {
  return { name, type: 'multipleRecordLinks', options: { linkedTableId: tableId } };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== LaunchDeck Production Schema Setup ===\n');

  // 1. Create tables (order matters for linked records)
  console.log('Step 1: Creating tables...');

  // 2a. Team Members (no dependencies)
  const teamMembersId = await createTable('Team Members', [
    { name: 'Name', type: 'singleLineText' },
    { name: 'Email', type: 'email' },
    { name: 'Slack Handle', type: 'singleLineText' },
    ss('Role', ['Designer', 'Senior Designer', 'CSM', 'Onboarding Ops', 'Admin']),
    cb('Active'),
  ]);

  // 2b. Brokerages (no dependencies)
  const brokeragesId = await createTable('Brokerages', [
    { name: 'Name', type: 'singleLineText' },
    { name: 'Landing Page Slug', type: 'singleLineText' },
    { name: 'Default Workflow Key', type: 'singleLineText' },
    { name: 'Roster API URL', type: 'url' },
    { name: 'Roster API Key', type: 'singleLineText' },
    { name: 'Roster Refresh Interval', type: 'singleLineText' },
    dt('Last Roster Sync'),
    { name: 'Billing Contact', type: 'email' },
    { name: 'Notes', type: 'multilineText' },
    cb('Active'),
  ]);

  // 2c. Customers (links to Team Members, Brokerages)
  const customersId = await createTable('Customers', [
    { name: 'Name', type: 'singleLineText' },
    ss('Type', ['D2C', 'B2B']),
    { name: 'Channel', type: 'singleLineText' },
    { name: 'Contact Email', type: 'email' },
    { name: 'Platform Email', type: 'email' },
    { name: 'Phone', type: 'phoneNumber' },
    // Business Info
    { name: 'Business Name', type: 'singleLineText' },
    { name: 'Business Address', type: 'multilineText' },
    { name: 'Website', type: 'url' },
    { name: 'Service Areas', type: 'multilineText' },
    { name: 'Bio', type: 'multilineText' },
    { name: 'License Number', type: 'singleLineText' },
    { name: 'Topics', type: 'multilineText' },
    { name: 'Hashtags', type: 'singleLineText' },
    { name: 'GMB Name', type: 'singleLineText' },
    { name: 'MLS IDs', type: 'multilineText' },
    { name: 'Special Instructions', type: 'multilineText' },
    // Assets
    { name: 'Agent Photo', type: 'multipleAttachments' },
    { name: 'Business Logo', type: 'multipleAttachments' },
    { name: 'Other Assets', type: 'multipleAttachments' },
    // Payment & Deal (D2C)
    { name: 'HubSpot Deal ID', type: 'singleLineText' },
    { name: 'Stripe Payment ID', type: 'singleLineText' },
    { name: 'Add-On Stripe Payment ID', type: 'singleLineText' },
    ss('Product Tier', ['Premium', 'Luxury']),
    ss('Payment Status', ['Paid', 'Waived']),
    // Enterprise (B2B)
    link('Brokerage', brokeragesId),
    // Assignment
    link('CSM Assigned', teamMembersId),
    // Design Workflow (D2C)
    ss('Design Approval', ['Pending', 'Approved', 'Changes Requested']),
    { name: 'Design Feedback', type: 'multilineText' },
    // Status Tracking
    { name: 'Current Stage', type: 'singleLineText' },
    dt('Stage Entered At'),
    cb('Account Created'),
    cb('Credentials Sent'),
    cb('Call Booked'),
    cb('Call Completed'),
    num('Reminder Count'),
  ]);

  // 2d. Workflow Templates (no dependencies)
  const workflowTemplatesId = await createTable('Workflow Templates', [
    { name: 'Workflow Key', type: 'singleLineText' },
    { name: 'Stage', type: 'singleLineText' },
    num('Stage Order'),
    { name: 'Task Title', type: 'singleLineText' },
    ss('Task Type', ['Client', 'Team']),
    num('Task Order'),
    cb('Visible To Client'),
    ss('Assigned Role', ['Designer', 'Senior Designer', 'CSM', 'Onboarding Ops']),
    ss('Initial Status', ['Active', 'Draft']),
    { name: 'Depends On', type: 'singleLineText' },
    cb('Has Team Review'),
    ss('Attachment Type', ['None', 'Form', 'File Upload', 'Embed', 'Proof']),
    { name: 'Embed URL', type: 'url' },
    { name: 'Instructions', type: 'multilineText' },
  ]);

  // 2e. Roster (links to Brokerages, Customers)
  const rosterId = await createTable('Roster', [
    { name: 'Email', type: 'email' },
    link('Brokerage', brokeragesId),
    { name: 'Agent Name', type: 'singleLineText' },
    { name: 'Phone', type: 'phoneNumber' },
    { name: 'License Number', type: 'singleLineText' },
    { name: 'Website', type: 'url' },
    { name: 'Photo URL', type: 'url' },
    { name: 'Logo URL', type: 'url' },
    { name: 'Bio', type: 'multilineText' },
    { name: 'Service Areas', type: 'multilineText' },
    { name: 'MLS IDs', type: 'multilineText' },
    { name: 'Topics', type: 'multilineText' },
    { name: 'Hashtags', type: 'singleLineText' },
    { name: 'GMB Name', type: 'singleLineText' },
    { name: 'Other Emails', type: 'multilineText' },
    ss('Onboarding Status', ['Not Started', 'In Progress', 'Completed']),
    link('Customer Record', customersId),
    dt('Synced At'),
  ]);

  // 2f. Tasks (links to Customers, Team Members)
  const tasksId = await createTable('Tasks', [
    { name: 'Task Name', type: 'singleLineText' },
    link('Customer', customersId),
    ss('Task Type', ['Client', 'Team']),
    { name: 'Stage', type: 'singleLineText' },
    ss('Status', ['Draft', 'Active', 'In Review', 'Completed', 'Rejected']),
    num('Task Order'),
    link('Assigned To', teamMembersId),
    cb('Visible To Client'),
    { name: 'Depends On', type: 'singleLineText' },
    cb('Has Team Review'),
    ss('Attachment Type', ['None', 'Form', 'File Upload', 'Embed', 'Proof']),
    { name: 'Embed URL', type: 'url' },
    { name: 'Instructions', type: 'multilineText' },
    ms('Tags', ['Design Change', 'Dev Request', 'Priority', 'Follow Up']),
    { name: 'Notes', type: 'multilineText' },
    { name: 'Due Date', type: 'date', options: { dateFormat: { name: 'iso' } } },
    dt('Completed At'),
  ]);

  // 2g. Events (links to Customers, Tasks, Team Members)
  await createTable('Events', [
    link('Customer', customersId),
    ss('Event Type', [
      'Customer Created', 'Stage Changed', 'Task Created', 'Task Activated',
      'Task Completed', 'Task Rejected', 'Task Sent to Review',
      'Design Uploaded', 'Design Approved', 'Design Changes Requested',
      'Call Booked', 'Call Completed', 'Reminder Sent', 'Note Added',
      'Credentials Sent', 'Account Created',
    ]),
    link('Actor', teamMembersId),
    ss('Actor Type', ['Customer', 'Team Member', 'System']),
    { name: 'Details', type: 'multilineText' },
    link('Related Task', tasksId),
  ]);

  console.log('\n  All 7 tables created.');

  // 2. Seed Team Members
  console.log('\nStep 2: Seeding Team Members...');
  const teamMembers = await batchCreate('Team Members', [
    { fields: { Name: 'Mario', Email: 'mario@rejig.ai', 'Slack Handle': '@mario', Role: 'CSM', Active: true } },
    { fields: { Name: 'Luis', Email: 'luis@rejig.ai', 'Slack Handle': '@luis', Role: 'CSM', Active: true } },
  ]);
  console.log(`  Seeded ${teamMembers.length} team members.`);

  // 3. Seed Brokerages
  console.log('\nStep 3: Seeding Brokerages...');
  const brokerages = await batchCreate('Brokerages', [
    { fields: { Name: 'Keyes', 'Landing Page Slug': 'keyes', 'Default Workflow Key': 'B2B-Keyes', 'Roster Refresh Interval': 'daily', Active: true } },
    { fields: { Name: 'Baird & Warner', 'Landing Page Slug': 'bw', 'Default Workflow Key': 'B2B-BW', 'Roster Refresh Interval': 'weekly', Active: true } },
  ]);
  console.log(`  Seeded ${brokerages.length} brokerages.`);

  // 4. Seed Workflow Templates
  console.log('\nStep 4: Seeding Workflow Templates...');

  const templates = [
    // ── D2C-Standard (17 tasks, 6 stages) ──
    { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Complete Your Onboarding Form', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Form', Instructions: 'Please complete this form so our team can get started on your brand kit.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Upload Logos and Headshots', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'File Upload', Instructions: 'Upload your logo files (PNG/SVG preferred), professional headshots, and any brand assets.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Create Designs', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Assigned Role': 'Designer', 'Initial Status': 'Draft', 'Depends On': 'Complete Your Onboarding Form, Upload Logos and Headshots', 'Has Team Review': true, 'Attachment Type': 'None', Instructions: 'Pull assets from client submissions. Create brand kit using uploaded logos, headshots, and bio.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Review Your Designs', 'Stage Order': 2, 'Task Title': 'Upload Proof to Customer', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Assigned Role': 'Designer', 'Initial Status': 'Draft', 'Depends On': 'Create Designs', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Upload the approved design files to the client review task.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Review Your Designs', 'Stage Order': 2, 'Task Title': 'Review & Approve Your Brand Kit', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Upload Proof to Customer', 'Has Team Review': false, 'Attachment Type': 'Proof', Instructions: 'Review your brand kit. Approve if correct, or request changes.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Move Designs to Production', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Assigned Role': 'Designer', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Move approved design assets to the production environment.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Create Customer Account', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Assigned Role': 'Onboarding Ops', 'Initial Status': 'Draft', 'Depends On': 'Move Designs to Production', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: "Create the customer's app.rejig.ai account using their Platform Email." },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Send Credentials', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Assigned Role': 'Onboarding Ops', 'Initial Status': 'Draft', 'Depends On': 'Create Customer Account', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Send login credentials to the customer.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Schedule Your Onboarding Call', 'Task Type': 'Client', 'Task Order': 4, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Book your onboarding call at a time that works for you.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Prepare for Onboarding', 'Stage Order': 4, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Watch this short video to learn how to connect and configure your service areas.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Prepare for Onboarding', 'Stage Order': 4, 'Task Title': 'Sign In & Reset Password', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Log in to app.rejig.ai using the credentials we sent and reset your password.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Prepare for Onboarding', 'Stage Order': 4, 'Task Title': 'Mark Onboarding Call Complete', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Assigned Role': 'CSM', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Mark complete after the onboarding call. If no-show or rescheduled, add a comment.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Post Onboarding Follow Ups', 'Stage Order': 5, 'Task Title': 'Send Zoom Recording', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Assigned Role': 'CSM', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Upload or send the onboarding call Zoom recording to the customer.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Post Onboarding Follow Ups', 'Stage Order': 5, 'Task Title': 'Send Follow-Up Email', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Assigned Role': 'CSM', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Send summary of what was covered, outstanding items, and next steps.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Review & Grow', 'Stage Order': 6, 'Task Title': 'Provide Onboarding Feedback', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Form', Instructions: "We'd love your feedback on the onboarding experience." },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Review & Grow', 'Stage Order': 6, 'Task Title': 'Schedule Check-In 1', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Provide Onboarding Feedback', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Schedule your first check-in call.' },
    { 'Workflow Key': 'D2C-Standard', Stage: 'Review & Grow', 'Stage Order': 6, 'Task Title': 'Schedule Check-In 2', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Check-In 1', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Schedule your second check-in call.' },

    // ── B2B-Keyes (11 tasks, 3 stages) ──
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Confirm Your Information', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Form', Instructions: 'Review the information we have on file. Update if needed.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Start Your Trial', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Follow the instructions to activate your trial account.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Schedule Your Onboarding Call', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Book your onboarding call.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Create Customer Account', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Assigned Role': 'Onboarding Ops', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: "Create the agent's app.rejig.ai account using their roster email." },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Send Credentials', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Assigned Role': 'Onboarding Ops', 'Initial Status': 'Draft', 'Depends On': 'Create Customer Account', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Send login credentials to the agent.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Watch this short video to configure your service areas.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Sign In & Reset Password', 'Task Type': 'Client', 'Task Order': 4, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Log in and reset your password.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Mark Onboarding Call Complete', 'Task Type': 'Team', 'Task Order': 5, 'Visible To Client': false, 'Assigned Role': 'CSM', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Mark complete after the onboarding call.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Provide Onboarding Feedback', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Form', Instructions: "We'd love your feedback." },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 1', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Provide Onboarding Feedback', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Schedule your first check-in call.' },
    { 'Workflow Key': 'B2B-Keyes', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 2', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Check-In 1', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Schedule your second check-in call.' },

    // ── B2B-BW (10 tasks, 3 stages) ──
    { 'Workflow Key': 'B2B-BW', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Confirm Your Information', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Form', Instructions: 'Review the information we have on file. Update if needed.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Schedule Your Onboarding Call', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Book your onboarding call.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Create Customer Account', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Assigned Role': 'Onboarding Ops', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: "Create the agent's app.rejig.ai account using their roster email." },
    { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Send Credentials', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Assigned Role': 'Onboarding Ops', 'Initial Status': 'Draft', 'Depends On': 'Create Customer Account', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Send login credentials to the agent.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Watch this short video to configure your service areas.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Sign In & Reset Password', 'Task Type': 'Client', 'Task Order': 4, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Log in and reset your password.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Mark Onboarding Call Complete', 'Task Type': 'Team', 'Task Order': 5, 'Visible To Client': false, 'Assigned Role': 'CSM', 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'None', Instructions: 'Mark complete after the onboarding call.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Provide Onboarding Feedback', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': '', 'Has Team Review': false, 'Attachment Type': 'Form', Instructions: "We'd love your feedback." },
    { 'Workflow Key': 'B2B-BW', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 1', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Provide Onboarding Feedback', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Schedule your first check-in call.' },
    { 'Workflow Key': 'B2B-BW', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 2', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Check-In 1', 'Has Team Review': false, 'Attachment Type': 'Embed', Instructions: 'Schedule your second check-in call.' },
  ];

  const templateRecords = templates.map((t) => ({ fields: t }));
  const created = await batchCreate('Workflow Templates', templateRecords);
  console.log(`  Seeded ${created.length} workflow templates (17 D2C + 11 Keyes + 10 B&W).`);

  // Done
  console.log('\n=== Setup Complete ===');
  console.log(`\n  Tables created: 7`);
  console.log(`  Team Members: ${teamMembers.length}`);
  console.log(`  Brokerages: ${brokerages.length}`);
  console.log(`  Workflow Templates: ${created.length}`);
  console.log(`\n  Customers table ID: ${customersId}`);
  console.log(`  Tasks table ID: ${tasksId}`);
  console.log(`\nNext: update src/types and src/lib/airtable.ts to match production schema.`);
}

main().catch((err) => {
  console.error('\nSetup failed:', err);
  process.exit(1);
});
