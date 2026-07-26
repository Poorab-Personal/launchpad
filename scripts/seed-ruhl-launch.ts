/**
 * Onboard Ruhl (RuhlHomes) as a new B2B brokerage — PILOT phase.
 *
 * Pilot scope: intake-form submission ONLY. No Stripe payment, no
 * onboarding-call booking. Both are added later once the pilot ends (this
 * workflow's single task terminates the customer at currentStage='Submitted'
 * — see CORE_TERMINAL_STAGE_OVERRIDE in src/lib/automations/activate-dependents.ts).
 *
 * All work runs inside one db.transaction; any throw rolls everything back.
 * Idempotent:
 *   - Channel insert uses ON CONFLICT (code) DO NOTHING.
 *   - Brokerage insert uses ON CONFLICT (landing_page_slug) DO NOTHING.
 *   - Template insert is sentinel-guarded: if any B2B-RUHL rows already
 *     exist, the insert step is skipped.
 *
 * Usage: npx tsx scripts/seed-ruhl-launch.ts
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const RUHL_SUPPORT_CONTACT_NAME: string | null = null;
const RUHL_SUPPORT_CONTACT_EMAIL: string | null = 'support@rejig.ai';
const RUHL_SUPPORT_CONTACT_PHONE: string | null = null;
// Placeholder — real Vercel Blob URL is stamped in by
// scripts/upload-brokerage-logo.ts ruhl <logo> ruhl-primary.png (run after this script).
const RUHL_MASTER_LOGO_URL: string | null = null;

const TARGET_WORKFLOW_KEY = 'B2B-RUHL';

async function main() {
  const { db } = await import('../src/db');
  const { channels } = await import('../src/db/schema/channels');
  const { brokerages } = await import('../src/db/schema/brokerages');
  const { workflowTemplates } = await import('../src/db/schema/workflowTemplates');
  const { eq, sql } = await import('drizzle-orm');

  type NewChannel = typeof channels.$inferInsert;
  type NewBrokerage = typeof brokerages.$inferInsert;
  type NewWorkflowTemplate = typeof workflowTemplates.$inferInsert;

  await db.transaction(async (tx) => {
    // -------------------------------------------------------------------
    // Step 1. Insert RUHL channel.
    // -------------------------------------------------------------------
    console.log('Step 1: Inserting RUHL channel...');
    const channelRow: NewChannel = {
      code: 'RUHL',
      displayName: 'RuhlHomes',
      customerType: 'B2B',
      active: true,
    };
    const channelResult = await tx
      .insert(channels)
      .values(channelRow)
      .onConflictDoNothing({ target: channels.code })
      .returning({ id: channels.id, code: channels.code });

    if (channelResult.length === 0) {
      console.log('  Channel RUHL already exists — skipped.');
    } else {
      console.log(`  Inserted channel RUHL (id=${channelResult[0].id}).`);
    }

    // -------------------------------------------------------------------
    // Step 2. Insert Ruhl brokerage.
    // -------------------------------------------------------------------
    console.log('\nStep 2: Inserting Ruhl brokerage...');
    const brokerageRow: NewBrokerage = {
      name: 'RuhlHomes',
      shortName: 'Ruhl',
      landingPageSlug: 'ruhl',
      defaultWorkflowKey: TARGET_WORKFLOW_KEY,
      defaultCalendlyUrl: null,          // no call task in this pilot
      hubspotCompanyId: '54969811333',
      hubspotDealId: '334066018015',
      active: true,
      includesVoice: false,
      includesAvatar: false,
      masterLogoUrl: RUHL_MASTER_LOGO_URL,
      sourceType: 'dmg',
      sourceConfig: { credEnvPrefix: 'DMG_RUHL' },
      verificationMode: 'soft',
      supportContactName: RUHL_SUPPORT_CONTACT_NAME,
      supportContactEmail: RUHL_SUPPORT_CONTACT_EMAIL,
      supportContactPhone: RUHL_SUPPORT_CONTACT_PHONE,
    };
    const brokerageResult = await tx
      .insert(brokerages)
      .values(brokerageRow)
      .onConflictDoNothing({ target: brokerages.landingPageSlug })
      .returning({ id: brokerages.id, slug: brokerages.landingPageSlug });

    if (brokerageResult.length === 0) {
      console.log('  Brokerage with slug=ruhl already exists — skipped.');
    } else {
      console.log(`  Inserted brokerage Ruhl (id=${brokerageResult[0].id}, slug=${brokerageResult[0].slug}).`);
    }

    // -------------------------------------------------------------------
    // Step 3. Insert the single B2B-RUHL workflow_templates row.
    //
    // Sentinel guard: if B2B-RUHL rows already exist, skip insertion.
    // -------------------------------------------------------------------
    console.log(`\nStep 3: Inserting ${TARGET_WORKFLOW_KEY} workflow template...`);

    const existing = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowTemplates)
      .where(eq(workflowTemplates.workflowKey, TARGET_WORKFLOW_KEY));
    const existingCount = existing[0]?.count ?? 0;

    if (existingCount > 0) {
      console.log(`  ${existingCount} ${TARGET_WORKFLOW_KEY} row(s) already exist — skipping insert.`);
      return;
    }

    const newRow: NewWorkflowTemplate = {
      workflowKey: TARGET_WORKFLOW_KEY,
      stage: 'Getting Started',
      stageOrder: 1,
      taskOrder: 1,
      taskTitle: 'Confirm Your Information',
      taskType: 'Client',
      initialStatus: 'Active',
      dependsOn: null,
      attachmentType: 'Form',
      product: 'Core',
      instructions: 'Review the information we have on file. Update if needed.',
      paymentMode: 'none',
      trialDays: null,
    };

    const inserted = await tx
      .insert(workflowTemplates)
      .values(newRow)
      .returning({
        id: workflowTemplates.id,
        workflowKey: workflowTemplates.workflowKey,
        stage: workflowTemplates.stage,
        taskTitle: workflowTemplates.taskTitle,
      });

    console.log(`  Inserted ${inserted.length} ${TARGET_WORKFLOW_KEY} template row(s).`);
    for (const r of inserted) {
      console.log(`    - [${r.stage}] ${r.taskTitle}`);
    }
  });

  console.log('\nDone. Ruhl launch seed complete.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
