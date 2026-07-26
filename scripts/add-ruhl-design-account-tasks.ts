/**
 * Rework of the B2B-RUHL pilot workflow: originally intake-only ("Confirm
 * Your Information" was the sole task, terminating at a custom 'Submitted'
 * stage). Product decision (2026-07-26): keep it a full design + account-
 * creation flow like B2B-BW, just without the onboarding-call task or
 * Stripe (both come later, tied to the real HubSpot onboarding meeting).
 *
 * Adds 5 rows to workflow_templates, copied verbatim from B2B-BW's
 * equivalent tasks (field values, instructions, embed URL) minus "Schedule
 * Your Onboarding Call". paymentMode stays 'none' (matches the existing
 * "Confirm Your Information" row — Ruhl has no billing relationship yet).
 *
 * Sentinel-guarded: skips insertion if B2B-RUHL already has more than the
 * original 1 row (i.e. this script already ran).
 *
 * Usage: npx tsx --env-file=.env.local scripts/add-ruhl-design-account-tasks.ts
 */

async function main() {
  const { db } = await import('../src/db');
  const { workflowTemplates } = await import('../src/db/schema/workflowTemplates');
  const { eq, sql } = await import('drizzle-orm');

  type NewWorkflowTemplate = typeof workflowTemplates.$inferInsert;
  const TARGET_WORKFLOW_KEY = 'B2B-RUHL';

  const existing = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.workflowKey, TARGET_WORKFLOW_KEY));
  const existingCount = existing[0]?.count ?? 0;

  if (existingCount > 1) {
    console.log(`${TARGET_WORKFLOW_KEY} already has ${existingCount} rows (expected 1) — skipping, already reworked.`);
    process.exit(0);
  }

  const newRows: NewWorkflowTemplate[] = [
    {
      workflowKey: TARGET_WORKFLOW_KEY,
      stage: 'Getting Started',
      stageOrder: 1,
      taskOrder: 2,
      taskTitle: 'Create Designs',
      taskType: 'Team',
      assignedRole: 'Designer',
      initialStatus: 'Draft',
      dependsOn: 'Confirm Your Information',
      hasTeamReview: true,
      attachmentType: 'None',
      visibleToClient: false,
      product: 'Core',
      instructions:
        'Create the agent\'s brand kit using their photo, logo, bio, and other inputs from the Customer record. Submit for senior review when ready. Customer will not see the design — once senior approves, account creation can proceed.',
      paymentMode: 'none',
    },
    {
      workflowKey: TARGET_WORKFLOW_KEY,
      stage: 'Prepare for Onboarding',
      stageOrder: 2,
      taskOrder: 1,
      taskTitle: 'Create Customer Account',
      taskType: 'Team',
      assignedRole: 'Account Creator',
      initialStatus: 'Draft',
      dependsOn: 'Create Designs',
      attachmentType: 'None',
      visibleToClient: false,
      product: 'Core',
      instructions: 'Create the agent app.rejig.ai account using their roster email.',
      paymentMode: 'none',
    },
    {
      workflowKey: TARGET_WORKFLOW_KEY,
      stage: 'Prepare for Onboarding',
      stageOrder: 2,
      taskOrder: 2,
      taskTitle: 'Send Credentials',
      taskType: 'Team',
      assignedRole: 'Account Creator',
      initialStatus: 'Draft',
      dependsOn: 'Create Customer Account',
      attachmentType: 'None',
      visibleToClient: false,
      product: 'Core',
      instructions: 'Send login credentials to the agent.',
      paymentMode: 'none',
    },
    {
      workflowKey: TARGET_WORKFLOW_KEY,
      stage: 'Prepare for Onboarding',
      stageOrder: 2,
      taskOrder: 3,
      taskTitle: 'Watch Setup Video',
      taskType: 'Client',
      initialStatus: 'Draft',
      dependsOn: 'Send Credentials',
      attachmentType: 'Embed',
      embedUrl: 'https://www.loom.com/share/8da6e238719c45e7b678bb2d053d533f',
      visibleToClient: true,
      product: 'Core',
      instructions: 'Watch this short video to configure your service areas.',
      paymentMode: 'none',
    },
    {
      workflowKey: TARGET_WORKFLOW_KEY,
      stage: 'Prepare for Onboarding',
      stageOrder: 2,
      taskOrder: 4,
      taskTitle: 'Sign In & Reset Password',
      taskType: 'Client',
      initialStatus: 'Draft',
      dependsOn: 'Send Credentials',
      attachmentType: 'None',
      visibleToClient: true,
      product: 'Core',
      instructions: 'Log in and reset your password.',
      paymentMode: 'none',
    },
  ];

  const inserted = await db
    .insert(workflowTemplates)
    .values(newRows)
    .returning({
      id: workflowTemplates.id,
      stage: workflowTemplates.stage,
      taskTitle: workflowTemplates.taskTitle,
    });

  console.log(`Inserted ${inserted.length} B2B-RUHL template row(s):`);
  for (const r of inserted) {
    console.log(`  - [${r.stage}] ${r.taskTitle}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
