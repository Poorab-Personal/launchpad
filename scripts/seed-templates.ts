/**
 * Seed Workflow Templates into Airtable.
 *
 * Usage: npx tsx scripts/seed-templates.ts
 *
 * Requires AIRTABLE_PAT and AIRTABLE_BASE_ID in .env.local (or environment).
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import {
  getRecords,
  batchCreateRecords,
} from '../src/lib/airtable-client';

const TABLE = 'Workflow Templates';

interface TemplateRow {
  'Workflow Key': string;
  'Stage': string;
  'Stage Order': number;
  'Task Title': string;
  'Task Type': string;
  'Task Order': number;
  'Visible To Client': boolean;
  'Initial Status': string;
  'Depends On': string;
  'Attachment Type': string;
  'Instructions': string;
  'Has Team Review'?: boolean;
}

const SEED_DATA: TemplateRow[] = [
  // ── D2C-Standard (17 tasks, 6 stages) ──
  { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Complete Your Onboarding Form', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'Please complete this form so our team can get started on your brand kit.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Upload Logos and Headshots', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'File Upload', Instructions: 'Upload your logo files (PNG/SVG preferred), professional headshots, and any brand assets.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Create Designs', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Complete Your Onboarding Form, Upload Logos and Headshots', 'Attachment Type': 'None', Instructions: 'Pull assets from client submissions. Create brand kit using uploaded logos, headshots, and bio.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Review Your Designs', 'Stage Order': 2, 'Task Title': 'Upload Proof to Customer', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Create Designs', 'Attachment Type': 'None', Instructions: 'Upload the approved design files to the client review task.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Review Your Designs', 'Stage Order': 2, 'Task Title': 'Review & Approve Your Brand Kit', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Upload Proof to Customer', 'Attachment Type': 'Proof', Instructions: 'Review your brand kit. Approve if correct, or request changes.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Move Designs to Production', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'None', Instructions: 'Move approved design assets to the production environment.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Create Customer Account', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Move Designs to Production', 'Attachment Type': 'None', Instructions: 'Create the customer app.rejig.ai account using their Platform Email.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Send Credentials', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Create Customer Account', 'Attachment Type': 'None', Instructions: 'Send login credentials to the customer.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Book Your Call', 'Stage Order': 3, 'Task Title': 'Schedule Your Onboarding Call', 'Task Type': 'Client', 'Task Order': 4, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'Embed', Instructions: 'Book your onboarding call at a time that works for you.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Prepare for Onboarding', 'Stage Order': 4, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'Embed', Instructions: 'Watch this short video to learn how to connect and configure your service areas.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Prepare for Onboarding', 'Stage Order': 4, 'Task Title': 'Sign In & Reset Password', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'None', Instructions: 'Log in to app.rejig.ai using the credentials we sent and reset your password.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Prepare for Onboarding', 'Stage Order': 4, 'Task Title': 'Mark Onboarding Call Complete', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'None', Instructions: 'Mark complete after the onboarding call. If no-show or rescheduled, add a comment.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Post Onboarding Follow Ups', 'Stage Order': 5, 'Task Title': 'Send Zoom Recording', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'None', Instructions: 'Upload or send the onboarding call Zoom recording to the customer.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Post Onboarding Follow Ups', 'Stage Order': 5, 'Task Title': 'Send Follow-Up Email', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'None', Instructions: 'Send summary of what was covered, outstanding items, and next steps.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Review & Grow', 'Stage Order': 6, 'Task Title': 'Provide Onboarding Feedback', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'We would love your feedback on the onboarding experience.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Review & Grow', 'Stage Order': 6, 'Task Title': 'Schedule Check-In 1', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Provide Onboarding Feedback', 'Attachment Type': 'Embed', Instructions: 'Schedule your first check-in call.' },
  { 'Workflow Key': 'D2C-Standard', Stage: 'Review & Grow', 'Stage Order': 6, 'Task Title': 'Schedule Check-In 2', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Check-In 1', 'Attachment Type': 'Embed', Instructions: 'Schedule your second check-in call.' },

  // ── B2B-Keyes (12 tasks, 3 stages) ──
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Confirm Your Information', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'Review the information we have on file. Update if needed.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Capture Payment Method', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Confirm Your Information', 'Attachment Type': 'Payment Setup', Instructions: "Add a payment method to start your free trial. Your trial begins after your onboarding call \u2014 you won't be charged during the trial period." },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Schedule Your Onboarding Call', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Capture Payment Method', 'Attachment Type': 'Embed', Instructions: 'Book your onboarding call.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Create Designs', 'Task Type': 'Team', 'Task Order': 4, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Confirm Your Information, Capture Payment Method', 'Has Team Review': true, 'Attachment Type': 'None', Instructions: "Create the agent's brand kit using their photo, logo, bio, and other inputs from the Customer record. Submit for senior review when ready. Customer will not see the design — once senior approves, account creation can proceed." },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Create Customer Account', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Create Designs', 'Attachment Type': 'None', Instructions: 'Create the agent app.rejig.ai account using their roster email.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Send Credentials', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Create Customer Account', 'Attachment Type': 'None', Instructions: 'Send login credentials to the agent.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'Embed', Instructions: 'Watch this short video to configure your service areas.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Sign In & Reset Password', 'Task Type': 'Client', 'Task Order': 4, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'None', Instructions: 'Log in and reset your password.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Mark Onboarding Call Complete', 'Task Type': 'Team', 'Task Order': 5, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Schedule Your Onboarding Call', 'Attachment Type': 'None', Instructions: 'Mark complete after the onboarding call.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Provide Onboarding Feedback', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'We would love your feedback.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 1', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Provide Onboarding Feedback', 'Attachment Type': 'Embed', Instructions: 'Schedule your first check-in call.' },
  { 'Workflow Key': 'B2B-Keyes', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 2', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Check-In 1', 'Attachment Type': 'Embed', Instructions: 'Schedule your second check-in call.' },

  // ── B2B-BW (11 tasks, 3 stages) ──
  { 'Workflow Key': 'B2B-BW', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Confirm Your Information', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'Review the information we have on file. Update if needed.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Schedule Your Onboarding Call', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Active', 'Depends On': '', 'Attachment Type': 'Embed', Instructions: 'Book your onboarding call.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Getting Started', 'Stage Order': 1, 'Task Title': 'Create Designs', 'Task Type': 'Team', 'Task Order': 3, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Confirm Your Information', 'Has Team Review': true, 'Attachment Type': 'None', Instructions: "Create the agent's brand kit using their photo, logo, bio, and other inputs from the Customer record. Submit for senior review when ready. Customer will not see the design — once senior approves, account creation can proceed." },
  { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Create Customer Account', 'Task Type': 'Team', 'Task Order': 1, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Create Designs', 'Attachment Type': 'None', Instructions: 'Create the agent app.rejig.ai account using their roster email.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Send Credentials', 'Task Type': 'Team', 'Task Order': 2, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Create Customer Account', 'Attachment Type': 'None', Instructions: 'Send login credentials to the agent.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Watch Setup Video', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'Embed', Instructions: 'Watch this short video to configure your service areas.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Sign In & Reset Password', 'Task Type': 'Client', 'Task Order': 4, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Send Credentials', 'Attachment Type': 'None', Instructions: 'Log in and reset your password.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Prepare for Onboarding', 'Stage Order': 2, 'Task Title': 'Mark Onboarding Call Complete', 'Task Type': 'Team', 'Task Order': 5, 'Visible To Client': false, 'Initial Status': 'Draft', 'Depends On': 'Schedule Your Onboarding Call', 'Attachment Type': 'None', Instructions: 'Mark complete after the onboarding call.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Provide Onboarding Feedback', 'Task Type': 'Client', 'Task Order': 1, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': '', 'Attachment Type': 'Form', Instructions: 'We would love your feedback.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 1', 'Task Type': 'Client', 'Task Order': 2, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Provide Onboarding Feedback', 'Attachment Type': 'Embed', Instructions: 'Schedule your first check-in call.' },
  { 'Workflow Key': 'B2B-BW', Stage: 'Review & Grow', 'Stage Order': 3, 'Task Title': 'Schedule Check-In 2', 'Task Type': 'Client', 'Task Order': 3, 'Visible To Client': true, 'Initial Status': 'Draft', 'Depends On': 'Schedule Check-In 1', 'Attachment Type': 'Embed', Instructions: 'Schedule your second check-in call.' },
];

async function main() {
  console.log('Fetching existing Workflow Templates...');
  const existing = await getRecords(TABLE);

  const existingKeys = new Set(
    existing.map(
      (r) => `${r.fields['Workflow Key']}::${r.fields['Task Title']}`,
    ),
  );

  const toCreate = SEED_DATA.filter(
    (row) => !existingKeys.has(`${row['Workflow Key']}::${row['Task Title']}`),
  );

  if (toCreate.length === 0) {
    console.log('All templates already exist. Nothing to seed.');
    return;
  }

  console.log(`Creating ${toCreate.length} new template(s)...`);
  const records = toCreate.map((fields) => ({ fields: fields as unknown as Record<string, unknown> }));
  const created = await batchCreateRecords(TABLE, records);
  console.log(`Seeded ${created.length} Workflow Template record(s).`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
