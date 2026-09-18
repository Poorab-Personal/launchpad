/**
 * Onboard Coach Realtors as a new B2B brokerage.
 *
 * Shape: a B2B-BW clone. No Stripe in the agent flow (`payment_mode='invoice'`
 * — the brokerage is billed off submissions and reconciled out-of-band), agent
 * confirms roster-prefilled info → books the onboarding call, with the design +
 * account-creation chain hanging off the submission.
 *
 * Templates are CLONED FROM THE LIVE B2B-BW ROWS rather than retyped, so the
 * new workflow inherits the real dependency graph (including the intentional
 * `Create Designs` drift documented in memory `template_drift_intent`) and
 * can't diverge through a transcription slip.
 *
 * The one deliberate difference from B&W: Coach supplies agent logos through a
 * shared Dropbox folder instead of the roster feed (DMG carries no per-agent
 * logo field — only a headshot), so the Create Designs instructions carry a
 * manual "check the folder" step. The matching Slack reminder lives in
 * src/lib/automations/notify-new-customer.ts (DESIGN_ASSET_FOLDER).
 *
 * All work runs inside one db.transaction; any throw rolls everything back.
 * Idempotent:
 *   - Channel insert uses ON CONFLICT (code) DO NOTHING.
 *   - Brokerage insert uses ON CONFLICT (landing_page_slug) DO NOTHING.
 *   - Template insert is sentinel-guarded on existing B2B-Coach rows.
 *
 * Usage: npx tsx --env-file=.env.local scripts/seed-coach-launch.ts
 *        npx tsx --env-file=.env.local scripts/seed-coach-launch.ts --dry-run
 */

// ─── INPUTS ───────────────────────────────────────────────────────────────
// Every value below is a real input from the product owner. Anything left as
// null/'' is safe to seed with (the feature degrades quietly) EXCEPT
// HUBSPOT_COMPANY_ID — without it the intake handler short-circuits and no
// ticket is ever created for a Coach agent.

const BROKERAGE_NAME = 'Coach Realtors';
const SHORT_NAME = 'Coach';
const LANDING_SLUG = 'coach';
const CHANNEL_CODE = 'Coach';               // → workflow_key `B2B-Coach`
const TARGET_WORKFLOW_KEY = 'B2B-Coach';
const SOURCE_WORKFLOW_KEY = 'B2B-BW';       // clone source
const CRED_ENV_PREFIX = 'DMG_COACH';        // creds already in .env.local

// REQUIRED before a real agent submits — intake push fails loudly without it.
const HUBSPOT_COMPANY_ID: string | null = '333661991614';
const HUBSPOT_DEAL_ID: string | null = null;

// HubSpot Meetings link for "Schedule Your Onboarding Call". Falls back to the
// shared link B&W/Keyes/IPRE use today if left null.
const ONBOARDING_MEETING_URL: string | null = null;

// Shown on the "we don't see you in the roster" failure screen.
const SUPPORT_CONTACT_NAME: string | null = null;
const SUPPORT_CONTACT_EMAIL: string | null = 'support@rejig.ai';
const SUPPORT_CONTACT_PHONE: string | null = null;

// Stamped in afterwards by: npx tsx scripts/upload-brokerage-logo.ts coach <file>
const MASTER_LOGO_URL: string | null = null;

// Shared Dropbox folder holding agent-supplied logos. Appended to the
// Create Designs instructions when set.
const DROPBOX_FOLDER_URL: string | null =
  'https://www.dropbox.com/scl/fo/bxmwrwlr5h26hfc91rvrz/ACQKT2nPOKAbx3OZeaVTI58?rlkey=3yso8uu2zcmvn5n9q9rke1wkz&st=05uxzac9&e=1&dl=0';

const PRICING_TAGLINE = 'Your AI social media assistant, exclusively for {Name} agents.';
// ──────────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const { db } = await import('../src/db');
  const { channels } = await import('../src/db/schema/channels');
  const { brokerages } = await import('../src/db/schema/brokerages');
  const { workflowTemplates } = await import('../src/db/schema/workflowTemplates');
  const { eq, sql } = await import('drizzle-orm');

  type NewChannel = typeof channels.$inferInsert;
  type NewBrokerage = typeof brokerages.$inferInsert;
  type NewWorkflowTemplate = typeof workflowTemplates.$inferInsert;

  if (DRY_RUN) console.log('*** DRY RUN — transaction will be rolled back ***\n');

  await db.transaction(async (tx) => {
    // ── Step 1. Channel ────────────────────────────────────────────────
    console.log(`Step 1: Inserting ${CHANNEL_CODE} channel...`);
    const channelRow: NewChannel = {
      code: CHANNEL_CODE,
      displayName: BROKERAGE_NAME,
      customerType: 'B2B',
      active: true,
    };
    const channelResult = await tx
      .insert(channels)
      .values(channelRow)
      .onConflictDoNothing({ target: channels.code })
      .returning({ id: channels.id, code: channels.code });
    console.log(
      channelResult.length === 0
        ? `  Channel ${CHANNEL_CODE} already exists — skipped.`
        : `  Inserted channel ${CHANNEL_CODE} (id=${channelResult[0].id}).`,
    );

    // ── Step 2. Brokerage ──────────────────────────────────────────────
    console.log(`\nStep 2: Inserting ${BROKERAGE_NAME} brokerage...`);
    const brokerageRow: NewBrokerage = {
      name: BROKERAGE_NAME,
      shortName: SHORT_NAME,
      landingPageSlug: LANDING_SLUG,
      defaultWorkflowKey: TARGET_WORKFLOW_KEY,
      defaultCalendlyUrl: null,
      hubspotCompanyId: HUBSPOT_COMPANY_ID,
      hubspotDealId: HUBSPOT_DEAL_ID,
      active: true,
      includesVoice: false,
      includesAvatar: false,
      masterLogoUrl: MASTER_LOGO_URL,
      pricingTagline: PRICING_TAGLINE,
      sourceType: 'dmg',
      sourceConfig: { credEnvPrefix: CRED_ENV_PREFIX },
      verificationMode: 'soft',
      supportContactName: SUPPORT_CONTACT_NAME,
      supportContactEmail: SUPPORT_CONTACT_EMAIL,
      supportContactPhone: SUPPORT_CONTACT_PHONE,
    };
    const brokerageResult = await tx
      .insert(brokerages)
      .values(brokerageRow)
      .onConflictDoNothing({ target: brokerages.landingPageSlug })
      .returning({ id: brokerages.id, slug: brokerages.landingPageSlug });
    console.log(
      brokerageResult.length === 0
        ? `  Brokerage slug=${LANDING_SLUG} already exists — skipped.`
        : `  Inserted brokerage ${BROKERAGE_NAME} (id=${brokerageResult[0].id}).`,
    );

    // ── Step 3. Clone workflow templates from B2B-BW ───────────────────
    console.log(`\nStep 3: Cloning ${SOURCE_WORKFLOW_KEY} → ${TARGET_WORKFLOW_KEY}...`);

    const existing = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowTemplates)
      .where(eq(workflowTemplates.workflowKey, TARGET_WORKFLOW_KEY));
    if ((existing[0]?.count ?? 0) > 0) {
      console.log(`  ${existing[0].count} ${TARGET_WORKFLOW_KEY} row(s) already exist — skipping.`);
      return;
    }

    const sourceRows = await tx
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.workflowKey, SOURCE_WORKFLOW_KEY));
    if (sourceRows.length === 0) {
      throw new Error(`No ${SOURCE_WORKFLOW_KEY} rows to clone from — aborting.`);
    }
    console.log(`  Read ${sourceRows.length} source row(s) from ${SOURCE_WORKFLOW_KEY}.`);

    const dropboxNote = DROPBOX_FOLDER_URL
      ? ` FIRST: check the shared Dropbox folder for an agent-supplied logo before you start — ${DROPBOX_FOLDER_URL}. ${SHORT_NAME} agents' logos are not in the roster feed, so if one exists it is only in that folder.`
      : '';

    const cloned: NewWorkflowTemplate[] = sourceRows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id: _id, ...rest } = r;
      return {
        ...rest,
        workflowKey: TARGET_WORKFLOW_KEY,
        // Coach-only: point the call task at its own meeting link if given.
        embedUrl:
          r.taskTitle === 'Schedule Your Onboarding Call' && ONBOARDING_MEETING_URL
            ? ONBOARDING_MEETING_URL
            : r.embedUrl,
        // Coach-only: manual logo-folder step lives in the design instructions.
        instructions:
          r.taskTitle === 'Create Designs' && dropboxNote
            ? `${r.instructions ?? ''}${dropboxNote}`
            : r.instructions,
      } as NewWorkflowTemplate;
    });

    const inserted = await tx
      .insert(workflowTemplates)
      .values(cloned)
      .returning({
        stage: workflowTemplates.stage,
        stageOrder: workflowTemplates.stageOrder,
        taskOrder: workflowTemplates.taskOrder,
        taskTitle: workflowTemplates.taskTitle,
        taskType: workflowTemplates.taskType,
        dependsOn: workflowTemplates.dependsOn,
      });

    console.log(`  Inserted ${inserted.length} ${TARGET_WORKFLOW_KEY} template row(s):`);
    for (const r of inserted.sort((a, b) => a.stageOrder - b.stageOrder || a.taskOrder - b.taskOrder)) {
      const dep = r.dependsOn ? `  ← ${r.dependsOn}` : '';
      console.log(`    [${r.stageOrder}.${r.taskOrder}] ${r.taskTitle} (${r.taskType})${dep}`);
    }

    // ── Warnings ───────────────────────────────────────────────────────
    const warnings: string[] = [];
    if (!HUBSPOT_COMPANY_ID) warnings.push('hubspot_company_id is NULL — intake push will fail for every Coach agent until set.');
    if (!MASTER_LOGO_URL) warnings.push('master_logo_url is NULL — run scripts/upload-brokerage-logo.ts coach <file>.');
    if (!DROPBOX_FOLDER_URL) warnings.push('DROPBOX_FOLDER_URL unset — no logo-folder step in Create Designs, no Slack reminder line.');
    if (warnings.length) {
      console.log('\n  ⚠ Outstanding:');
      for (const w of warnings) console.log(`    - ${w}`);
    }

    if (DRY_RUN) {
      throw new Error('__DRY_RUN_ROLLBACK__');
    }
  }).catch((e: unknown) => {
    if (e instanceof Error && e.message === '__DRY_RUN_ROLLBACK__') {
      console.log('\nDry run complete — rolled back, nothing written.');
      return;
    }
    throw e;
  });

  if (!DRY_RUN) console.log('\nDone. Coach launch seed complete.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
