/**
 * Funnel audit — B2B brokerages.
 *
 * Reports each customer on a workflow against the conversion funnel
 * (Stage 1 client-visible tasks, in template order). Auto-derives
 * milestones from `workflow_templates` so new brokerages work for free.
 *
 * Usage:
 *   npx tsx scripts/funnel-audit.ts <workflow_key|brokerage_slug> [flags]
 *
 *   <workflow_key>      e.g. B2B-IPRE, B2B-Keyes, B2B-BW
 *   <brokerage_slug>    e.g. ipre, keyes, bw  (matched against brokerages.slug)
 *
 * Flags:
 *   --csv                       also write CSV to scripts/data/<workflow>-funnel-<YYYY-MM-DD>.csv
 *   --full                      include all stages (not just Stage 1 conversion funnel)
 *   --customer <q>              drill down to a single customer (matches name or email substring)
 *   --include-test              include customers with 'test' in their environment array (excluded by default)
 *   --email <a,b,c>             email the report to comma-separated recipients (CSV attached automatically)
 *   --subject <s>               override email subject
 *
 * Examples:
 *   npx tsx scripts/funnel-audit.ts B2B-IPRE
 *   npx tsx scripts/funnel-audit.ts ipre --csv
 *   npx tsx scripts/funnel-audit.ts B2B-Keyes --customer poorab@
 *   npx tsx scripts/funnel-audit.ts ipre --email poorab@rejig.ai
 */
import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getStateLabel,
  getOnboardedRule,
  STARTED_LABEL,
  STUCK_DAYS_THRESHOLD,
} from './funnel-audit-labels';

dotenv.config({ path: '.env.local' });

type Args = {
  target: string;
  csv: boolean;
  full: boolean;
  customer: string | null;
  includeTest: boolean;
  email: string[];
  subject: string | null;
  stuckDays: number;
  /** Freeform HTML/text callout rendered above the funnel table in the email.
   *  Inline text, or `@path` to read a file. For manual annotations (e.g. a
   *  Stripe-reconciliation summary) that don't belong in the per-customer table. */
  noteTop: string | null;
  /** Same as noteTop, rendered below the per-customer table. */
  noteBottom: string | null;
};

/** Resolve a note arg: `@path` reads a file, anything else is used verbatim. */
function resolveNote(v: string): string {
  if (v.startsWith('@')) {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(v.slice(1), 'utf8');
  }
  return v;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let csv = false;
  let full = false;
  let includeTest = false;
  let customer: string | null = null;
  let email: string[] = [];
  let subject: string | null = null;
  let stuckDays = STUCK_DAYS_THRESHOLD;
  let noteTop: string | null = null;
  let noteBottom: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') csv = true;
    else if (a === '--full') full = true;
    else if (a === '--include-test') includeTest = true;
    else if (a === '--customer') customer = argv[++i] ?? null;
    else if (a === '--email') {
      const v = argv[++i] ?? '';
      email = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--subject') subject = argv[++i] ?? null;
    else if (a === '--stuck-days') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (Number.isNaN(v) || v < 0) {
        console.error(`--stuck-days requires a non-negative integer`);
        process.exit(2);
      }
      stuckDays = v;
    } else if (a === '--note-top') noteTop = resolveNote(argv[++i] ?? '');
    else if (a === '--note-bottom') noteBottom = resolveNote(argv[++i] ?? '');
    else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else positional.push(a);
  }

  if (positional.length === 0) {
    console.error(
      'Usage: npx tsx scripts/funnel-audit.ts <workflow_key|brokerage_slug> [--csv] [--full] [--customer <q>] [--include-test] [--email <a,b>] [--subject <s>] [--stuck-days N]',
    );
    process.exit(2);
  }
  return { target: positional[0], csv, full, customer, includeTest, email, subject, stuckDays, noteTop, noteBottom };
}

async function resolveWorkflowKey(target: string): Promise<string> {
  if (target.startsWith('B2B-') || target.startsWith('D2C-')) {
    if (!target.startsWith('B2B-')) {
      console.error('This skill covers B2B workflows only. Use B2B-IPRE / B2B-Keyes / B2B-BW.');
      process.exit(2);
    }
    return target;
  }
  // Treat as brokerage slug
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');
  const row = await db
    .select({ workflowKey: schema.brokerages.defaultWorkflowKey, name: schema.brokerages.name })
    .from(schema.brokerages)
    .where(eq(schema.brokerages.landingPageSlug, target.toLowerCase()))
    .limit(1);
  if (row.length === 0) {
    console.error(`No brokerage with slug "${target}". Pass a workflow_key directly (e.g. B2B-IPRE).`);
    process.exit(2);
  }
  if (!row[0].workflowKey.startsWith('B2B-')) {
    console.error(`Brokerage "${target}" maps to ${row[0].workflowKey} — this skill is B2B-only.`);
    process.exit(2);
  }
  return row[0].workflowKey;
}

type Row = {
  name: string;
  contactEmail: string;
  platformEmail: string;
  phone: string;
  funnelStage: string;
  callDate: string;
  subscription: string;
  subscriptionState: string;
  monthlyAmount: string;
  trialEndsOn: string;
  created: string;
  daysSinceCreated: number;
  stuck: boolean;
  env: string;
  hubspotTicketId: string;
  stripeSubscriptionId: string;
};

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workflowKey = await resolveWorkflowKey(args.target);
  const onboardedRule = getOnboardedRule(workflowKey);

  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { eq, and, inArray, asc, or, ilike } = await import('drizzle-orm');

  // Derive milestones from workflow_templates
  const tmplRows = await db
    .select({
      stage: schema.workflowTemplates.stage,
      stageOrder: schema.workflowTemplates.stageOrder,
      taskOrder: schema.workflowTemplates.taskOrder,
      taskTitle: schema.workflowTemplates.taskTitle,
      visibleToClient: schema.workflowTemplates.visibleToClient,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.workflowKey, workflowKey))
    .orderBy(
      asc(schema.workflowTemplates.stageOrder),
      asc(schema.workflowTemplates.taskOrder),
    );

  if (tmplRows.length === 0) {
    console.error(`No workflow_templates rows for ${workflowKey}.`);
    process.exit(1);
  }

  const milestones = tmplRows
    .filter((t) => t.visibleToClient && (args.full || t.stageOrder === 1))
    .map((t) => {
      const label = getStateLabel(workflowKey, t.taskTitle);
      return {
        stage: t.stage,
        taskTitle: t.taskTitle,
        bucketLabel: label ?? t.taskTitle,
        mapped: label !== undefined,
      };
    });

  if (milestones.length === 0) {
    console.error(`No client-visible milestones for ${workflowKey} at the requested scope.`);
    process.exit(1);
  }

  const unmapped = milestones.filter((m) => !m.mapped).map((m) => m.taskTitle);

  // Pull customers
  const custWhere = args.customer
    ? and(
        eq(schema.customers.workflowKey, workflowKey),
        or(
          ilike(schema.customers.name, `%${args.customer}%`),
          ilike(schema.customers.contactEmail, `%${args.customer}%`),
          ilike(schema.customers.platformEmail, `%${args.customer}%`),
        ),
      )
    : eq(schema.customers.workflowKey, workflowKey);

  const allCustomers = await db
    .select()
    .from(schema.customers)
    .where(custWhere)
    .orderBy(asc(schema.customers.createdAt));

  const customers = args.includeTest
    ? allCustomers
    : allCustomers.filter((c) => !c.environment?.includes('test'));

  if (customers.length === 0) {
    console.log(`No customers found for ${workflowKey}${args.customer ? ` matching "${args.customer}"` : ''}.`);
    return;
  }

  const ids = customers.map((c) => c.id);
  const milestoneTitles = milestones.map((m) => m.taskTitle);

  const taskRows = await db
    .select({
      customerId: schema.tasks.customerId,
      taskName: schema.tasks.taskName,
      status: schema.tasks.status,
    })
    .from(schema.tasks)
    .where(and(inArray(schema.tasks.customerId, ids), inArray(schema.tasks.taskName, milestoneTitles)));

  const byCust = new Map<string, Record<string, string>>();
  for (const t of taskRows) {
    if (!byCust.has(t.customerId)) byCust.set(t.customerId, {});
    byCust.get(t.customerId)![t.taskName] = t.status;
  }

  // Onboarding call data per customer
  const callRows = await db
    .select({
      customerId: schema.calls.customerId,
      type: schema.calls.type,
      status: schema.calls.status,
      scheduledDate: schema.calls.scheduledDate,
    })
    .from(schema.calls)
    .where(and(inArray(schema.calls.customerId, ids), eq(schema.calls.type, 'Onboarding')));

  // Pick the most recent Onboarding call per customer (any status).
  // The single date carries both meanings:
  //   - For "Booked" bucket: this is the upcoming call date
  //   - For "Onboarded" bucket: this is the date the call happened
  // (Onboarded is gated on subscriptionStatus, not call status — see below.)
  const callByCust = new Map<string, Date>();
  for (const c of callRows) {
    const cur = callByCust.get(c.customerId);
    if (!cur || c.scheduledDate > cur) callByCust.set(c.customerId, c.scheduledDate);
  }

  // Plan price lookup: stripe_plans for this workflow → priceDisplay + pricePeriod
  const plans = await db
    .select({
      stripePriceId: schema.stripePlans.stripePriceId,
      priceDisplay: schema.stripePlans.priceDisplay,
      pricePeriod: schema.stripePlans.pricePeriod,
    })
    .from(schema.stripePlans)
    .where(eq(schema.stripePlans.workflowKey, workflowKey));

  const planByPriceId = new Map<string, { priceDisplay: string | null; pricePeriod: string | null }>();
  for (const p of plans) planByPriceId.set(p.stripePriceId, p);

  const formatPrice = (priceId: string | null | undefined): string => {
    if (!priceId) return '';
    const p = planByPriceId.get(priceId);
    if (!p) return '';
    const display = p.priceDisplay ?? '';
    const period = p.pricePeriod ?? '';
    return `${display}${period}`.trim();
  };

  // Trial-end date from customer_subscriptions (Core product)
  const subs = await db
    .select({
      customerId: schema.customerSubscriptions.customerId,
      product: schema.customerSubscriptions.product,
      status: schema.customerSubscriptions.status,
      currentPeriodEnd: schema.customerSubscriptions.currentPeriodEnd,
    })
    .from(schema.customerSubscriptions)
    .where(inArray(schema.customerSubscriptions.customerId, ids));

  const coreSubByCust = new Map<
    string,
    { status: string | null; currentPeriodEnd: Date | null }
  >();
  for (const s of subs) {
    if (s.product !== 'Core') continue;
    coreSubByCust.set(s.customerId, {
      status: s.status,
      currentPeriodEnd: s.currentPeriodEnd,
    });
  }

  // Trial-end / renewal-date fallback to LIVE Stripe.
  //
  // The report's preferred source is customer_subscriptions.currentPeriodEnd
  // (Core). But that table is only populated on the Deal-closedwon path —
  // workflows that activate via the HS ticket→Active trial-create (e.g.
  // B2B-IPRE) never get a row, so their trial ends would show blank.
  // For any customer with a live sub but no DB period-end, fetch the sub's
  // trial_end (or current period end) directly from Stripe. No Stripe key →
  // silently degrade to DB-only. Once the customer_subscriptions backfill
  // lands, needStripe is empty and Stripe is never called.
  const stripeEndByCust = new Map<string, Date>();
  const needStripe = customers.filter(
    (c) =>
      (c.subscriptionStatus === 'Trial' || c.subscriptionStatus === 'Active') &&
      c.stripeSubscriptionId &&
      !coreSubByCust.get(c.id)?.currentPeriodEnd,
  );
  if (needStripe.length > 0) {
    const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
    if (key) {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(key);
      for (const c of needStripe) {
        try {
          const sub = await stripe.subscriptions.retrieve(c.stripeSubscriptionId!, {
            expand: ['items.data'],
          });
          // Newer Stripe API moved current_period_end onto the items; keep the
          // legacy sub-level field as a fallback. trial_end wins while trialing.
          const subObj = sub as unknown as {
            trial_end?: number | null;
            current_period_end?: number | null;
            items?: { data?: Array<{ current_period_end?: number }> };
          };
          const endSec =
            subObj.trial_end ??
            subObj.items?.data?.[0]?.current_period_end ??
            subObj.current_period_end ??
            null;
          if (endSec) stripeEndByCust.set(c.id, new Date(endSec * 1000));
        } catch {
          /* missing/deleted sub — leave blank */
        }
      }
    } else {
      console.warn(
        `⚠  ${needStripe.length} customer(s) have a live sub but no customer_subscriptions period-end, and no Stripe key is set — Trial Ends will be blank for them.`,
      );
    }
  }

  // Furthest milestone reached. Index 0 = Started (no milestone completed).
  // 1..N = milestone N completed.
  const BUCKET_NAMES = [STARTED_LABEL, ...milestones.map((m) => m.bucketLabel)];

  const nowMs = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const rows: Row[] = customers.map((c) => {
    const taskStatuses = byCust.get(c.id) ?? {};
    let furthestIdx = 0;
    for (let i = 0; i < milestones.length; i++) {
      if (taskStatuses[milestones[i].taskTitle] === 'Completed') furthestIdx = i + 1;
      else break;
    }
    const allMilestonesDone = furthestIdx === milestones.length;

    // "Onboarded" gate — workflow-configurable
    let onboarded = false;
    if (allMilestonesDone) {
      if (onboardedRule === 'subscription') {
        onboarded = !!c.subscriptionStatus;
      } else {
        onboarded = !!c.currentStage && c.currentStage !== 'Getting Started';
      }
    }

    const bucket = onboarded ? 'Onboarded' : BUCKET_NAMES[furthestIdx];

    // Call Date: filled for "Booked" and "Onboarded" buckets only
    const showCallDate = bucket === 'Onboarded' || (allMilestonesDone && !onboarded);
    const callDate = showCallDate ? fmtDate(callByCust.get(c.id)) : '';

    // Subscription column
    const priceStr = formatPrice(c.selectedStripePriceId); // e.g. "$199/mo"
    const sub = coreSubByCust.get(c.id);
    // Prefer the DB period-end; fall back to the live-Stripe value fetched above.
    const trialEnd = sub?.currentPeriodEnd ?? stripeEndByCust.get(c.id) ?? null;
    let subscription = '';
    let subscriptionState = '';
    let trialEndsOn = '';

    if (c.subscriptionStatus === 'Active') {
      subscriptionState = 'Paying';
      subscription = `Paying ${priceStr || '?'}`;
      trialEndsOn = fmtDate(trialEnd); // renewal date for payers
    } else if (c.subscriptionStatus === 'Trial') {
      subscriptionState = 'Trial';
      trialEndsOn = fmtDate(trialEnd);
      subscription = `Trial ${priceStr || '?'}`;
    } else if (c.subscriptionStatus === 'Past Due') {
      subscriptionState = 'Past Due';
      subscription = `Past Due ${priceStr || '?'}`;
    } else if (c.subscriptionStatus === 'Cancelled') {
      subscriptionState = 'Cancelled';
      subscription = `Cancelled ${priceStr || '?'}`;
    } else if (onboarded) {
      subscriptionState = 'Missing';
      subscription = '⚠ no sub';
    } else if (priceStr) {
      subscriptionState = 'Pending';
      subscription = `${priceStr} (pending)`;
    } else {
      subscriptionState = '';
      subscription = '';
    }

    const daysSinceCreated = Math.floor((nowMs - c.createdAt.getTime()) / MS_PER_DAY);
    const isStuckEligible = bucket !== 'Booked' && bucket !== 'Onboarded';
    const stuck = isStuckEligible && daysSinceCreated >= args.stuckDays;

    return {
      name: c.name,
      contactEmail: c.contactEmail,
      platformEmail: c.platformEmail,
      phone: c.phone ?? '',
      funnelStage: bucket,
      callDate,
      subscription,
      subscriptionState,
      monthlyAmount: priceStr,
      trialEndsOn,
      created: c.createdAt.toISOString().slice(0, 10),
      daysSinceCreated,
      stuck,
      env: c.environment?.join(',') ?? '',
      hubspotTicketId: c.hubspotTicketId ?? '',
      stripeSubscriptionId: c.stripeSubscriptionId ?? '',
    };
  });

  // Counts
  const labelOrder = [STARTED_LABEL, ...milestones.map((m) => m.bucketLabel), 'Onboarded'];
  const counts: Record<string, number> = Object.fromEntries(labelOrder.map((s) => [s, 0]));
  for (const r of rows) counts[r.funnelStage] = (counts[r.funnelStage] ?? 0) + 1;

  // Sort: furthest first, then by created date (oldest first — surfaces
  // who's been stuck longest within each bucket)
  const rank: Record<string, number> = Object.fromEntries(
    ['Onboarded', ...milestones.map((m) => m.bucketLabel).reverse(), STARTED_LABEL].map((s, i) => [s, i]),
  );
  rows.sort(
    (a, b) =>
      (rank[a.funnelStage] ?? 99) - (rank[b.funnelStage] ?? 99) ||
      a.created.localeCompare(b.created) ||
      a.name.localeCompare(b.name),
  );

  // -------- Terminal output --------
  // Drop the `B2B-` prefix in the display header / subject — readers don't
  // need the customer-type tag, they already know which brokerage they
  // asked about. CSV filename + internal logging keep the full key.
  const displayKey = workflowKey.replace(/^B2B-/, '');
  const header = `${displayKey} funnel — ${customers.length} customer(s)${args.customer ? ` matching "${args.customer}"` : ''}${args.includeTest ? '' : ' (excluding test env)'}`;
  console.log(`\n${header}\n`);

  if (unmapped.length > 0) {
    console.log(`⚠  Unmapped milestone(s) in ${workflowKey} — showing raw task title:`);
    for (const u of unmapped) console.log(`     - "${u}"`);
    console.log(`   Add to scripts/funnel-audit-labels.ts BASE_LABELS or PER_WORKFLOW['${workflowKey}'].\n`);
  }

  console.log('Funnel stage:');
  const labelW = Math.max(...labelOrder.map((l) => l.length)) + 2;
  for (const label of labelOrder) {
    console.log(`  ${label.padEnd(labelW)} ${counts[label] ?? 0}`);
  }

  const cols = [
    { key: 'name', label: 'Name' },
    { key: 'funnelStage', label: 'Funnel Stage' },
    { key: 'callDate', label: 'Call Date' },
    { key: 'subscription', label: 'Subscription' },
    { key: 'trialEndsOn', label: 'Trial Ends' },
    { key: 'contactEmail', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'created', label: 'Created' },
  ] as const;

  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String((r as Record<string, unknown>)[c.key] ?? '').length)),
  );

  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  console.log('\n' + sep);
  console.log(
    '| ' + cols.map((c, i) => c.label.padEnd(widths[i])).join(' | ') + ' |',
  );
  console.log(sep);
  for (const r of rows) {
    const line =
      '| ' +
      cols
        .map((c, i) => String((r as Record<string, unknown>)[c.key] ?? '').padEnd(widths[i]))
        .join(' | ') +
      ' |';
    console.log(r.stuck ? `\x1b[31m${line}\x1b[0m` : line);
  }
  console.log(sep);

  // -------- CSV --------
  const csvCols = [
    'name',
    'funnelStage',
    'callDate',
    'subscriptionState',
    'monthlyAmount',
    'trialEndsOn',
    'contactEmail',
    'platformEmail',
    'phone',
    'created',
    'daysSinceCreated',
    'stuck',
    'env',
    'hubspotTicketId',
    'stripeSubscriptionId',
  ] as const;
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvLines = [csvCols.join(',')];
  for (const r of rows) {
    csvLines.push(csvCols.map((c) => esc((r as Record<string, unknown>)[c])).join(','));
  }
  const csvBody = csvLines.join('\n') + '\n';

  const today = new Date().toISOString().slice(0, 10);
  const csvName = `${workflowKey.toLowerCase()}-funnel-${today}.csv`;

  if (args.csv) {
    const csvPath = resolve('scripts/data', csvName);
    writeFileSync(csvPath, csvBody);
    console.log(`\nCSV written: ${csvPath}`);
  }

  // -------- Email --------
  if (args.email.length > 0) {
    const subject = args.subject ?? `${displayKey} funnel — ${today} (${customers.length} customer${customers.length === 1 ? '' : 's'})`;
    const html = buildEmailHtml({
      header,
      workflowKey,
      labelOrder,
      counts,
      rows,
      cols: cols.map((c) => ({ key: c.key, label: c.label })),
      unmapped,
      today,
      noteTop: args.noteTop,
      noteBottom: args.noteBottom,
    });

    await sendFunnelEmail({
      to: args.email,
      subject,
      html,
      attachment: { filename: csvName, content: csvBody },
    });
    console.log(`\nEmail sent to: ${args.email.join(', ')}`);
  }
}

function escHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml(opts: {
  header: string;
  workflowKey: string;
  labelOrder: string[];
  counts: Record<string, number>;
  rows: Row[];
  cols: Array<{ key: string; label: string }>;
  unmapped: string[];
  today: string;
  noteTop?: string | null;
  noteBottom?: string | null;
}): string {
  const {
    header,
    workflowKey,
    labelOrder,
    counts,
    rows,
    cols,
    unmapped,
    today,
    noteTop,
    noteBottom,
  } = opts;

  // Callout boxes for manual annotations. Rendered as-is (caller supplies
  // trusted HTML); wrapped in a highlighted panel so they read as commentary
  // separate from the funnel data.
  const noteBox = (body: string) => `
    <div style="background:#f5f8ff;border:1px solid #c3d4f5;border-radius:6px;padding:12px 16px;margin:0 0 20px 0;font-size:13px;color:#1a2b4a;line-height:1.5;">
      ${body}
    </div>
  `;
  const noteTopHtml = noteTop ? noteBox(noteTop) : '';
  const noteBottomHtml = noteBottom ? noteBox(noteBottom) : '';

  const td = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;';
  const th =
    'padding:6px 10px;border-bottom:2px solid #444;background:#f6f6f6;font-size:13px;text-align:left;';

  const bucketTable = `
    <table style="border-collapse:collapse;margin:0 0 24px 0;">
      <tr>
        <th style="${th}">Stage</th>
        <th style="${th};text-align:right;">Count</th>
      </tr>
      ${labelOrder
        .map(
          (l) => `
        <tr>
          <td style="${td}">${escHtml(l)}</td>
          <td style="${td};text-align:right;">${counts[l] ?? 0}</td>
        </tr>`,
        )
        .join('')}
    </table>
  `;

  const unmappedBanner =
    unmapped.length === 0
      ? ''
      : `
    <div style="background:#fff4e5;border:1px solid #f0b67f;padding:10px 14px;margin:0 0 20px 0;font-size:13px;color:#7a4a00;">
      <strong>⚠ Unmapped milestone(s):</strong> ${unmapped.map((u) => escHtml(`"${u}"`)).join(', ')}.
      <br/>Add to <code>scripts/funnel-audit-labels.ts</code> to label them.
    </div>
  `;

  const tdStuck = `${td}background:#fff5f5;color:#a00;`;
  const mainTable = `
    <table style="border-collapse:collapse;margin:0 0 20px 0;width:100%;">
      <tr>
        ${cols.map((c) => `<th style="${th}">${escHtml(c.label)}</th>`).join('')}
      </tr>
      ${rows
        .map(
          (r) => `
        <tr>
          ${cols
            .map(
              (c) =>
                `<td style="${r.stuck ? tdStuck : td}">${escHtml(String((r as Record<string, unknown>)[c.key] ?? ''))}</td>`,
            )
            .join('')}
        </tr>`,
        )
        .join('')}
    </table>
  `;

  return `
<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;background:#fff;padding:24px;max-width:1100px;margin:0 auto;">
    <h2 style="margin:0 0 6px 0;font-size:18px;">${escHtml(header)}</h2>
    <div style="font-size:12px;color:#666;margin:0 0 14px 0;">Generated ${escHtml(today)}</div>
    ${unmappedBanner}
    ${noteTopHtml}
    <h3 style="margin:0 0 8px 0;font-size:14px;">Funnel stage</h3>
    ${bucketTable}
    <h3 style="margin:0 0 8px 0;font-size:14px;">Per-customer</h3>
    ${mainTable}
    ${noteBottomHtml}
    <div style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      Generated by funnel-audit skill. Rerun: <code>npx tsx scripts/funnel-audit.ts ${escHtml(
        workflowKey,
      )} --email ...</code>
    </div>
  </body>
</html>
  `.trim();
}

async function sendFunnelEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachment: { filename: string; content: string };
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);

  const result = await resend.emails.send({
    from: 'Rejig.ai Success Team <success@rejig.ai>',
    to: opts.to,
    replyTo: 'success@rejig.ai',
    subject: opts.subject,
    html: opts.html,
    attachments: [
      {
        filename: opts.attachment.filename,
        content: Buffer.from(opts.attachment.content, 'utf8').toString('base64'),
      },
    ],
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return result.data;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
