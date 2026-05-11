/**
 * Seed Postgres config tables from current Airtable state.
 *
 * Reads from Airtable, transforms Title Case → camelCase, inserts into Neon.
 * Wrapped in a transaction; full rollback on any failure.
 *
 * Idempotent: DELETEs from each target table before inserting. Safe to re-run
 * while we're pre-launch. After Phase 7 cutover, this script is retired
 * (Postgres becomes the source of truth; the seed is reference-only).
 *
 * Tables seeded:
 *   - channels         (3 hardcoded rows — new table, no Airtable source)
 *   - brokerages       (from Airtable Brokerages)
 *   - team_members     (from Airtable Team Members)
 *   - workflow_templates (from Airtable Workflow Templates)
 *   - stripe_plans     (from Airtable Stripe Plans)
 *   - settings         (1 hardcoded row — portal_base_url)
 *
 * Not seeded (these get migrated via a separate cutover script in Phase 7):
 *   customers, tasks, task_dependencies, calls, events, roster
 *
 * Run: npm run db:seed
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';

import { getRecords } from '../src/lib/airtable-client';
import * as schema from '../src/db/schema';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `\n  Missing env var: ${name}\n` +
        `  Restore it to .env.local. Likely options:\n` +
        `    vercel env pull .env.local.tmp --environment=production\n` +
        `    grep ${name} .env.local.tmp >> .env.local && rm .env.local.tmp\n` +
        `  (Or copy the value manually from Vercel dashboard.)\n`,
    );
    process.exit(1);
  }
  return v;
}

requireEnv('POSTGRES_URL_NON_POOLING');
requireEnv('AIRTABLE_PAT');
requireEnv('AIRTABLE_BASE_ID');

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.POSTGRES_URL_NON_POOLING });
const db = drizzle(pool, { schema });

// --- Transformers --------------------------------------------------------

function str(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}
function strReq(v: unknown, label: string): string {
  const s = str(v);
  if (s === null) throw new Error(`Required field "${label}" missing or empty`);
  return s;
}
function bool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null) return fallback;
  return Boolean(v);
}
function int(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  // Airtable single-select fields arrive as a single string. Wrap in a
  // length-1 array so the seed handles single- and multi-select fields
  // uniformly.
  if (typeof v === 'string' && v) return [v];
  return [];
}
function date(v: unknown): Date | null {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- Seed -----------------------------------------------------------------

async function seed() {
  await db.transaction(async (tx) => {
    console.log('Truncating config tables...');
    await tx.execute(sql`TRUNCATE TABLE
      ${schema.settings},
      ${schema.stripePlans},
      ${schema.workflowTemplates},
      ${schema.teamMembers},
      ${schema.brokerages},
      ${schema.channels}
      RESTART IDENTITY CASCADE`);

    // ---- channels (hardcoded; no Airtable source) ----
    console.log('Seeding channels...');
    const channelsRows = [
      { code: 'Standard', displayName: 'D2C Standard', customerType: 'D2C' as const },
      { code: 'Keyes', displayName: 'Keyes', customerType: 'B2B' as const },
      { code: 'BW', displayName: 'Baird & Warner', customerType: 'B2B' as const },
    ];
    await tx.insert(schema.channels).values(channelsRows);
    console.log(`  inserted ${channelsRows.length} channels`);

    // ---- brokerages ----
    console.log('Reading Brokerages from Airtable...');
    const atBrokerages = await getRecords('Brokerages');
    const brokeragesRows = atBrokerages.map((r) => {
      const f = r.fields;
      return {
        name: strReq(f['Name'], 'Brokerages.Name'),
        landingPageSlug: strReq(f['Landing Page Slug'], 'Brokerages.Landing Page Slug'),
        defaultWorkflowKey: strReq(f['Default Workflow Key'], 'Brokerages.Default Workflow Key'),
        rosterApiUrl: str(f['Roster API URL']),
        rosterApiKey: str(f['Roster API Key']),
        rosterRefreshInterval: str(f['Roster Refresh Interval']),
        lastRosterSync: date(f['Last Roster Sync']),
        defaultCalendlyUrl: str(f['Default Calendly URL']),
        billingContact: str(f['Billing Contact']),
        notes: str(f['Notes']),
        active: bool(f['Active'], true),
        includesVoice: bool(f['Includes Voice']),
        includesAvatar: bool(f['Includes Avatar']),
        pricingTagline: str(f['Pricing Tagline']),
      };
    });
    if (brokeragesRows.length) await tx.insert(schema.brokerages).values(brokeragesRows);
    console.log(`  inserted ${brokeragesRows.length} brokerages`);

    // ---- team_members ----
    console.log('Reading Team Members from Airtable...');
    const atTeam = await getRecords('Team Members');
    const teamRows = atTeam.map((r) => {
      const f = r.fields;
      const roles = arr(f['Role']);
      return {
        name: strReq(f['Name'], 'Team Members.Name'),
        email: strReq(f['Email'], 'Team Members.Email'),
        slackHandle: str(f['Slack Handle']),
        calendlyUrl: str(f['Calendly URL']),
        roles: roles as (typeof schema.teamRoleEnum.enumValues)[number][],
        active: bool(f['Active'], true),
        isDefault: bool(f['Is Default']),
      };
    });
    if (teamRows.length) await tx.insert(schema.teamMembers).values(teamRows);
    console.log(`  inserted ${teamRows.length} team members`);

    // ---- workflow_templates ----
    console.log('Reading Workflow Templates from Airtable...');
    const atTemplates = await getRecords('Workflow Templates');
    const templateRows = atTemplates.map((r) => {
      const f = r.fields;
      // Airtable Assigned Role can be a single value or array (depending on
      // field type). Coerce to single value or null.
      const roleRaw = f['Assigned Role'];
      const roleValue = Array.isArray(roleRaw) ? (roleRaw[0] ?? null) : (roleRaw ?? null);
      return {
        workflowKey: strReq(f['Workflow Key'], 'Workflow Templates.Workflow Key'),
        stage: strReq(f['Stage'], 'Workflow Templates.Stage'),
        stageOrder: int(f['Stage Order']) ?? 0,
        taskOrder: int(f['Task Order']) ?? 0,
        taskTitle: strReq(f['Task Title'], 'Workflow Templates.Task Title'),
        taskType: strReq(f['Task Type'], 'Workflow Templates.Task Type') as
          | 'Client'
          | 'Team',
        assignedRole: roleValue as (typeof schema.teamRoleEnum.enumValues)[number] | null,
        initialStatus: (str(f['Initial Status']) ?? 'Draft') as 'Active' | 'Draft',
        dependsOn: str(f['Depends On']),
        hasTeamReview: bool(f['Has Team Review']),
        attachmentType: (str(f['Attachment Type']) ?? 'None') as
          (typeof schema.attachmentTypeEnum.enumValues)[number],
        embedUrl: str(f['Embed URL']),
        visibleToClient: bool(f['Visible To Client'], true),
        product: (str(f['Product']) ?? 'Core') as 'Core' | 'Voice' | 'Avatar',
        instructions: str(f['Instructions']),
        dueDaysAfterActivation: int(f['Due Days After Activation']),
        planFeatures: str(f['Plan Features']),
        paymentMode: str(f['Payment Mode']) as
          | (typeof schema.paymentModeEnum.enumValues)[number]
          | null,
        trialDays: int(f['Trial Days']),
      };
    });
    if (templateRows.length) await tx.insert(schema.workflowTemplates).values(templateRows);
    console.log(`  inserted ${templateRows.length} workflow templates`);

    // ---- stripe_plans ----
    console.log('Reading Stripe Plans from Airtable...');
    const atPlans = await getRecords('Stripe Plans');
    const planRows = atPlans.map((r) => {
      const f = r.fields;
      return {
        planName: strReq(f['Plan Name'], 'Stripe Plans.Plan Name'),
        workflowKey: strReq(f['Workflow Key'], 'Stripe Plans.Workflow Key'),
        stripePriceId: strReq(f['Stripe Price ID'], 'Stripe Plans.Stripe Price ID'),
        active: bool(f['Active'], true),
        description: str(f['Description']),
        priceDisplay: str(f['Price Display']),
        pricePeriod: str(f['Price Period']),
        billingDetail: str(f['Billing Detail']),
        footnote: str(f['Footnote']),
        highlight: str(f['Highlight']),
        displayOrder: int(f['Display Order']),
      };
    });
    if (planRows.length) await tx.insert(schema.stripePlans).values(planRows);
    console.log(`  inserted ${planRows.length} stripe plans`);

    // ---- settings (hardcoded; no Airtable source — Portal Base URL is
    //      currently denormalized on Customer rows, not a Settings table) ----
    console.log('Seeding settings...');
    await tx.insert(schema.settings).values([
      {
        key: 'portal_base_url',
        value: 'https://launchpad-indol-ten.vercel.app',
        description: 'Base URL for customer portal links in emails and webhooks',
      },
    ]);
    console.log('  inserted 1 setting (portal_base_url)');
  });

  console.log('\nSeed complete.');
}

seed()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nSeed failed:', err);
    await pool.end();
    process.exit(1);
  });
