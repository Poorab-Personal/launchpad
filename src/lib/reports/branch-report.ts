/**
 * Branch report — the per-office onboarding picture for a B2B brokerage, and
 * the thing we actually send them.
 *
 * One implementation, two callers:
 *   - `scripts/branch-funnel-report.ts`  — the CLI (ad-hoc runs, CSV, preview)
 *   - `/api/cron/branch-report`          — the monthly unattended send
 *
 * It lives under src/ because tsconfig excludes scripts/ from the build, so a
 * cron route cannot import from there. Sharing one implementation is the whole
 * point: a brokerage-facing number that depends on which caller produced it is
 * worse than no number at all.
 *
 * computeBranchReport is side-effect free — no console, no filesystem, no
 * process.exit. Failures throw so the cron surfaces them rather than emailing
 * a half-built report. Terminal tables, CSV/JSON files and argv parsing stay
 * in the CLI.
 */
import { eq, and, or, inArray, isNull, asc, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import {
  getStateLabel,
  getOnboardedRule,
  STARTED_LABEL,
  STUCK_DAYS_THRESHOLD,
} from './branch-report-labels';

export type BranchReportOptions = {
  /** brokerages.landing_page_slug — 'keyes', 'ipre', ... */
  slug: string;
  /**
   * Reconcile subscription state against a live Stripe pull. Effectively
   * mandatory: customers.subscription_status is a mirror that goes stale
   * silently, so without this the counts will not match the KPI deck.
   */
  stripe: boolean;
  /** Shape for a brokerage recipient: drops phone numbers, plan prices and our product name. */
  external: boolean;
  /** Stripe rows whose email contains any of these are dropped (internal/test accounts). */
  exclude: string[];
  /** Restrict to offices whose name or number contains this substring. */
  branch?: string | null;
  includeTest?: boolean;
  stuckDays?: number;
};

export type BranchReportResult = Awaited<ReturnType<typeof computeBranchReport>>;

function branchNumberFrom(officePayload: Record<string, unknown> | undefined): string {
  const email = String(officePayload?.PublicEmail ?? '');
  const m = /^[a-z]+(\d{2,5})@/i.exec(email);
  return m ? m[1] : '';
}

type Agent = {
  branchKey: string;
  branchNo: string;
  branchName: string;
  name: string;
  contactEmail: string;
  phone: string;
  funnelStage: string;
  subscriptionState: string;
  monthlyAmount: string;
  callDate: string;
  trialEndsOn: string;
  created: string;
  daysSinceCreated: number;
  stuck: boolean;
  offRoster: boolean;
  createdVia: string;
  matchedBy: string;
  /** Live Stripe subscriber with no LaunchPad customer record (only with --stripe). */
  stripeOnly: boolean;
  /** Covered by a shared group/umbrella subscription rather than an individual one. */
  groupPlan: boolean;
  /** Live in the product on the latest Rejig pull, but no subscription anywhere. */
  unbilled: boolean;
};

type Branch = {
  branchKey: string;
  branchNo: string;
  branchName: string;
  rosterAgents: number;
  agents: Agent[];
};

const fmtDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Loose identity key for a person, used only as a FALLBACK when emails don't
 * match — agents routinely hold a Stripe sub under a personal address and an LP
 * record under their brokerage one. Strips the realtor-title noise ("PA",
 * "Realtor", "The Keyes Company", team names) and sorts the remaining tokens so
 * "Milagros Taylor" and "Milly Taylor Realtor Keyes Co." collapse together.
 */
const NAME_NOISE =
  /\b(pa|p\.a\.|llc|pllc|inc|realtor|realtors|realty|real|estate|professional|associate|broker|team|group|company|co|the|keyes|and|at|of)\b/g;
function nameKey(s: string): string {
  const cleaned = norm(s).replace(NAME_NOISE, ' ').replace(/[^a-z ]/g, ' ');
  return [...new Set(cleaned.split(/\s+/).filter((t) => t.length > 2))].sort().join(' ');
}

type StripeSub = { subId: string; name: string; email: string; state: 'Paying' | 'Trial'; plan: string };

/**
 * A subscription that several LaunchPad customers all point at is not a data
 * error — it's a group/umbrella plan, where the brokerage buys N seats on one
 * subscription and individual agents have no Stripe record of their own. The
 * Keyes pilot works this way: one sub, `quantity` seats, billed to the
 * brokerage's marketing address, on a price that isn't in `stripe_plans`.
 *
 * Consequences, both of which this function exists to prevent:
 *   - a per-price pull (stripe-subs.ts, and therefore the KPI deck) never sees
 *     these agents or their revenue at all;
 *   - a naive "no individual sub ⇒ churned" rule marks every seat-holder as
 *     lapsed, which is the opposite of the truth.
 *
 * Seats are a quantity, not a list, so Stripe cannot say WHICH agents hold
 * them. When the seat count is below the number of linked customers, the
 * difference is reported as unresolved rather than guessed at.
 */
async function findGroupPlans(
  subIds: string[],
): Promise<Map<string, { seats: number; amount: string; status: string }>> {
  const out = new Map<string, { seats: number; amount: string; status: string }>();
  if (subIds.length === 0) return out;
  const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) return out;
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(key);
  for (const id of subIds) {
    try {
      const sub = await stripe.subscriptions.retrieve(id);
      if (sub.status !== 'active' && sub.status !== 'trialing') continue;
      const item = sub.items.data[0];
      const cents = item?.price?.unit_amount ?? 0;
      const interval = item?.price?.recurring?.interval ?? '?';
      out.set(id, {
        seats: item?.quantity ?? 1,
        amount: `$${cents / 100}/${interval}`,
        status: sub.status,
      });
    } catch {
      /* deleted or inaccessible — treat as not a live group plan */
    }
  }
  return out;
}

/**
 * Live Stripe pull on this workflow's plan price IDs — the same selection rule
 * `scripts/stripe-subs.ts` uses, so the two reconcile.
 */
async function pullStripeSubs(
  priceIds: string[],
  planNameByPrice: Map<string, string>,
  exclude: string[],
): Promise<StripeSub[]> {
  const key = process.env.STRIPE_LIVE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe reconciliation needs STRIPE_SECRET_KEY (or STRIPE_LIVE_SECRET_KEY)');
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(key);

  const out: StripeSub[] = [];
  const seenSubIds = new Set<string>();
  for (const priceId of priceIds) {
    for (const status of ['active', 'trialing'] as const) {
      let startingAfter: string | undefined;
      for (;;) {
        const page = await stripe.subscriptions.list({
          price: priceId,
          status,
          limit: 100,
          starting_after: startingAfter,
          expand: ['data.customer'],
        });
        for (const sub of page.data) {
          if (seenSubIds.has(sub.id)) continue;
          seenSubIds.add(sub.id);
          const cust = sub.customer;
          const email = typeof cust === 'string' ? '' : ('email' in cust ? cust.email ?? '' : '');
          const name = typeof cust === 'string' ? '' : ('name' in cust ? cust.name ?? '' : '');
          const e = norm(email);
          if (exclude.some((x) => e.includes(x))) continue;
          out.push({
            subId: sub.id,
            name: name || email,
            email: e,
            state: status === 'active' ? 'Paying' : 'Trial',
            plan: planNameByPrice.get(priceId) ?? priceId,
          });
        }
        if (!page.has_more) break;
        startingAfter = page.data[page.data.length - 1]?.id;
        if (!startingAfter) break;
      }
    }
  }
  return out;
}

export async function computeBranchReport(rawOpts: BranchReportOptions) {
  const opts = {
    branch: null as string | null,
    includeTest: false,
    stuckDays: STUCK_DAYS_THRESHOLD,
    ...rawOpts,
  };

  // ---------- brokerage ----------
  const bk = await db
    .select({
      id: schema.brokerages.id,
      name: schema.brokerages.name,
      workflowKey: schema.brokerages.defaultWorkflowKey,
    })
    .from(schema.brokerages)
    .where(eq(schema.brokerages.landingPageSlug, opts.slug))
    .limit(1);
  if (bk.length === 0) {
    throw new Error(`No brokerage with slug "${opts.slug}".`);
  }
  const brokerage = bk[0];
  const workflowKey = brokerage.workflowKey;
  const onboardedRule = getOnboardedRule(workflowKey);

  // ---------- roster ----------
  const rosterRows = await db
    .select({
      customerId: schema.brokerageRoster.customerId,
      publicEmail: schema.brokerageRoster.publicEmail,
      privateEmail: schema.brokerageRoster.privateEmail,
      officeId: schema.brokerageRoster.primaryOfficeId,
      officeName: schema.brokerageRoster.officeName,
      displayName: schema.brokerageRoster.displayName,
      sourceData: schema.brokerageRoster.sourceData,
      deletedAt: schema.brokerageRoster.deletedAt,
    })
    .from(schema.brokerageRoster)
    .where(eq(schema.brokerageRoster.brokerageId, brokerage.id));

  const aliveRoster = rosterRows.filter((r) => !r.deletedAt);

  // Branch registry, built from live roster rows only (a branch's headcount
  // is its current roster; soft-deleted rows are ex-agents).
  const branches = new Map<string, Branch>();
  const branchMeta = (r: (typeof rosterRows)[number]) => {
    const key = r.officeId ?? '(none)';
    const office = (r.sourceData as { office?: Record<string, unknown> } | null)?.office;
    return {
      key,
      no: branchNumberFrom(office),
      name: r.officeName?.trim() || '(unnamed office)',
    };
  };
  for (const r of aliveRoster) {
    const m = branchMeta(r);
    let b = branches.get(m.key);
    if (!b) {
      b = { branchKey: m.key, branchNo: m.no, branchName: m.name, rosterAgents: 0, agents: [] };
      branches.set(m.key, b);
    }
    b.rosterAgents++;
    if (!b.branchNo && m.no) b.branchNo = m.no;
  }

  // Attribution indexes. customer_id wins; email is the backfill fallback.
  // Live rows are indexed first so an ex-agent row never shadows a live one.
  const branchByCustomerId = new Map<string, ReturnType<typeof branchMeta> & { alive: boolean }>();
  const branchByEmail = new Map<string, ReturnType<typeof branchMeta> & { alive: boolean }>();
  const branchByName = new Map<string, ReturnType<typeof branchMeta> & { alive: boolean }>();
  for (const r of [...aliveRoster, ...rosterRows.filter((x) => x.deletedAt)]) {
    const m = { ...branchMeta(r), alive: !r.deletedAt };
    if (r.customerId && !branchByCustomerId.has(r.customerId)) branchByCustomerId.set(r.customerId, m);
    for (const e of [r.publicEmail, r.privateEmail]) {
      const k = norm(e);
      if (k && !branchByEmail.has(k)) branchByEmail.set(k, m);
    }
    const nk = nameKey(r.displayName ?? '');
    if (nk && !branchByName.has(nk)) branchByName.set(nk, m);
  }

  // ---------- customers ----------
  // Union of workflow-key and brokerage-FK membership: the two disagree for a
  // handful of mistagged rows, and either one alone loses customers.
  const allCustomers = await db
    .select()
    .from(schema.customers)
    .where(
      or(
        eq(schema.customers.workflowKey, workflowKey),
        eq(schema.customers.brokerageId, brokerage.id),
      ),
    )
    .orderBy(asc(schema.customers.createdAt));

  // Plus anyone whose email is on this brokerage's roster but who got filed
  // under a different workflow key entirely.
  const seenIds = new Set(allCustomers.map((c) => c.id));
  const strayEmails = [...branchByEmail.keys()];
  const strays = strayEmails.length
    ? await db
        .select()
        .from(schema.customers)
        .where(
          or(
            inArray(schema.customers.contactEmail, strayEmails),
            inArray(schema.customers.platformEmail, strayEmails),
          ),
        )
    : [];
  for (const s of strays) if (!seenIds.has(s.id)) { allCustomers.push(s); seenIds.add(s.id); }

  const customers = opts.includeTest
    ? allCustomers
    : allCustomers.filter((c) => !c.environment?.includes('test'));

  if (customers.length === 0) {
    throw new Error(`No customers found for ${brokerage.name}.`);
  }

  // ---------- funnel milestones (same derivation as funnel-audit) ----------
  const tmplRows = await db
    .select({
      stageOrder: schema.workflowTemplates.stageOrder,
      taskOrder: schema.workflowTemplates.taskOrder,
      taskTitle: schema.workflowTemplates.taskTitle,
      visibleToClient: schema.workflowTemplates.visibleToClient,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.workflowKey, workflowKey))
    .orderBy(asc(schema.workflowTemplates.stageOrder), asc(schema.workflowTemplates.taskOrder));

  const milestones = tmplRows
    .filter((t) => t.visibleToClient && t.stageOrder === 1)
    .map((t) => ({
      taskTitle: t.taskTitle,
      bucketLabel: getStateLabel(workflowKey, t.taskTitle) ?? t.taskTitle,
      mapped: getStateLabel(workflowKey, t.taskTitle) !== undefined,
    }));
  if (milestones.length === 0) {
    throw new Error(`No client-visible Stage 1 milestones for ${workflowKey}.`);
  }
  const unmapped = milestones.filter((m) => !m.mapped).map((m) => m.taskTitle);

  const ids = customers.map((c) => c.id);
  const taskRows = await db
    .select({
      customerId: schema.tasks.customerId,
      taskName: schema.tasks.taskName,
      status: schema.tasks.status,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.customerId, ids),
        inArray(schema.tasks.taskName, milestones.map((m) => m.taskTitle)),
      ),
    );
  const statusByCust = new Map<string, Record<string, string>>();
  for (const t of taskRows) {
    if (!statusByCust.has(t.customerId)) statusByCust.set(t.customerId, {});
    statusByCust.get(t.customerId)![t.taskName] = t.status;
  }

  const callRows = await db
    .select({
      customerId: schema.calls.customerId,
      scheduledDate: schema.calls.scheduledDate,
    })
    .from(schema.calls)
    .where(and(inArray(schema.calls.customerId, ids), eq(schema.calls.type, 'Onboarding')));
  const callByCust = new Map<string, Date>();
  for (const c of callRows) {
    const cur = callByCust.get(c.customerId);
    if (!cur || c.scheduledDate > cur) callByCust.set(c.customerId, c.scheduledDate);
  }

  const plans = await db
    .select({
      stripePriceId: schema.stripePlans.stripePriceId,
      priceDisplay: schema.stripePlans.priceDisplay,
      pricePeriod: schema.stripePlans.pricePeriod,
    })
    .from(schema.stripePlans)
    .where(eq(schema.stripePlans.workflowKey, workflowKey));
  const planByPriceId = new Map(plans.map((p) => [p.stripePriceId, p]));
  const formatPrice = (priceId: string | null | undefined) => {
    if (!priceId) return '';
    const p = planByPriceId.get(priceId);
    if (!p) return '';
    return `${p.priceDisplay ?? ''}${p.pricePeriod ?? ''}`.trim();
  };

  const subRows = await db
    .select({
      customerId: schema.customerSubscriptions.customerId,
      product: schema.customerSubscriptions.product,
      currentPeriodEnd: schema.customerSubscriptions.currentPeriodEnd,
    })
    .from(schema.customerSubscriptions)
    .where(inArray(schema.customerSubscriptions.customerId, ids));
  const periodEndByCust = new Map<string, Date | null>();
  for (const s of subRows) {
    if (s.product !== 'Core') continue;
    periodEndByCust.set(s.customerId, s.currentPeriodEnd);
  }

  // ---------- classify + attribute ----------
  // Backfilled customers pre-date the LaunchPad funnel: `generate-tasks` is
  // skipped for created_via='backfill', so they have zero milestone tasks and
  // would otherwise all land in bucket 0 ("Started, didn't submit") — the
  // opposite of the truth, since every one of them is already a customer.
  // They get their own terminal bucket, classified by subscription state.
  const EXISTING = 'Existing customer';
  const isBackfilled = (c: { createdVia: string; currentStage: string }) =>
    c.createdVia === 'backfill' || c.currentStage === 'Backfilled';

  const BUCKET_NAMES = [STARTED_LABEL, ...milestones.map((m) => m.bucketLabel)];
  const labelOrder: string[] = [...BUCKET_NAMES, 'Onboarded', EXISTING];
  const UNATTRIBUTED = '(no branch on roster)';
  const nowMs = Date.now();
  const MS_PER_DAY = 86_400_000;

  const unattributed: Branch = {
    branchKey: '__none__',
    branchNo: '',
    branchName: UNATTRIBUTED,
    rosterAgents: 0,
    agents: [],
  };

  for (const c of customers) {
    const statuses = statusByCust.get(c.id) ?? {};
    let furthest = 0;
    for (let i = 0; i < milestones.length; i++) {
      if (statuses[milestones[i].taskTitle] === 'Completed') furthest = i + 1;
      else break;
    }
    const backfilled = isBackfilled(c);
    const allDone = furthest === milestones.length;
    const onboarded = allDone
      ? onboardedRule === 'subscription'
        ? !!c.subscriptionStatus
        : !!c.currentStage && c.currentStage !== 'Getting Started'
      : false;
    const bucket = backfilled ? EXISTING : onboarded ? 'Onboarded' : BUCKET_NAMES[furthest];

    const priceStr = formatPrice(c.selectedStripePriceId);
    let subscriptionState: string;
    if (c.subscriptionStatus === 'Active') subscriptionState = 'Paying';
    else if (c.subscriptionStatus === 'Trial') subscriptionState = 'Trial';
    else if (c.subscriptionStatus === 'Past Due') subscriptionState = 'Past Due';
    else if (c.subscriptionStatus === 'Cancelled') subscriptionState = 'Cancelled';
    else if (onboarded || backfilled) subscriptionState = 'Missing';
    else if (priceStr) subscriptionState = 'Pending';
    else subscriptionState = '';

    const days = Math.floor((nowMs - c.createdAt.getTime()) / MS_PER_DAY);

    const byId = branchByCustomerId.get(c.id);
    const byEmail =
      branchByEmail.get(norm(c.contactEmail)) ?? branchByEmail.get(norm(c.platformEmail));
    const hit = byId ?? byEmail;
    const target = hit ? branches.get(hit.key) : undefined;

    const agent: Agent = {
      branchKey: target?.branchKey ?? unattributed.branchKey,
      branchNo: target?.branchNo ?? '',
      branchName: target?.branchName ?? UNATTRIBUTED,
      name: c.name,
      contactEmail: c.contactEmail,
      phone: c.phone ?? '',
      funnelStage: bucket,
      subscriptionState,
      monthlyAmount: priceStr,
      callDate: allDone ? fmtDate(callByCust.get(c.id)) : '',
      trialEndsOn:
        subscriptionState === 'Trial' || subscriptionState === 'Paying'
          ? fmtDate(periodEndByCust.get(c.id) ?? null)
          : '',
      created: fmtDate(c.createdAt),
      daysSinceCreated: days,
      stuck:
        bucket !== 'Booked' &&
        bucket !== 'Onboarded' &&
        bucket !== EXISTING &&
        days >= opts.stuckDays,
      offRoster: !!hit && !hit.alive,
      createdVia: c.createdVia,
      matchedBy: byId ? 'roster link' : byEmail ? 'email' : 'none',
      stripeOnly: false,
      groupPlan: false,
      unbilled: false,
    };
    (target ?? unattributed).agents.push(agent);
  }

  // ---------- reconcile subscription state against live Stripe ----------
  // `subs` counts subscriptions (the unit the KPI deck and stripe-subs.ts report);
  // `paying`/`trial` count people. They differ when one agent holds two live subs
  // for two businesses — real, and deliberately not deduped away in the sub count.
  const stripeStats = {
    subs: 0,
    payingSubs: 0,
    trialSubs: 0,
    paying: 0,
    trial: 0,
    corrected: 0,
    cleared: 0,
    added: 0,
    groupSeats: 0,
    groupMembers: 0,
    groupUnresolved: 0,
    unbilled: 0,
    groupPlans: [] as Array<{ id: string; seats: number; amount: string; members: number }>,
    rejigSnapshot: '' as string,
  };
  if (opts.stripe) {
    const planNameByPrice = new Map(plans.map((p) => [p.stripePriceId, p.priceDisplay ?? '']));
    const subs = await pullStripeSubs(
      plans.map((p) => p.stripePriceId),
      planNameByPrice,
      opts.exclude,
    );
    stripeStats.subs = subs.length;
    stripeStats.payingSubs = subs.filter((s) => s.state === 'Paying').length;
    stripeStats.trialSubs = subs.filter((s) => s.state === 'Trial').length;

    // One person can legitimately hold two subs (separate businesses), so
    // collapse to a person before counting; keep Paying over Trial.
    const allAgents = [...displayAll()];
    const byEmailIdx = new Map<string, Agent>();
    const byNameIdx = new Map<string, Agent>();
    // Strongest key: the customer row already names this exact subscription.
    // Beats email/name guessing outright and is the only thing that resolves
    // agents billing under a different identity (see the Keyes pilot doc).
    const bySubIdIdx = new Map<string, Agent>();
    const agentByEmail = new Map(allAgents.map((a) => [norm(a.contactEmail), a]));
    for (const c of customers) {
      const a = agentByEmail.get(norm(c.contactEmail));
      if (a && c.stripeSubscriptionId) bySubIdIdx.set(c.stripeSubscriptionId, a);
    }
    for (const a of allAgents) {
      const e = norm(a.contactEmail);
      if (e && !byEmailIdx.has(e)) byEmailIdx.set(e, a);
      const nk = nameKey(a.name);
      if (nk && !byNameIdx.has(nk)) byNameIdx.set(nk, a);
    }

    const stateFor = new Map<Agent, 'Paying' | 'Trial'>();
    const orphans: StripeSub[] = [];
    for (const s of subs) {
      const hit =
        bySubIdIdx.get(s.subId) ||
        (s.email && byEmailIdx.get(s.email)) ||
        byNameIdx.get(nameKey(s.name));
      if (!hit) { orphans.push(s); continue; }
      const cur = stateFor.get(hit);
      if (cur !== 'Paying') stateFor.set(hit, s.state);
    }

    // Latest FULL Rejig pull (weekday rows are small deltas — comparing against
    // one would read most of the roster as absent). Emails come from the LP
    // customer the signal is joined to; unjoined signals carry no identity.
    const rejigActive = new Set<string>();
    {
      const snap = await db
        .select({ d: sql<string>`date(observed_at)`, n: sql<number>`count(distinct rejig_user_id)::int` })
        .from(schema.customerUsageSignals)
        .where(sql`source = 'rejig_api' AND signal_type = 'rejig.account_active'`)
        .groupBy(sql`date(observed_at)`)
        .having(sql`count(distinct rejig_user_id) > 500`)
        .orderBy(sql`date(observed_at) desc`)
        .limit(1);
      if (snap.length) {
        const rows = await db
          .select({ email: schema.customers.contactEmail })
          .from(schema.customerUsageSignals)
          .innerJoin(schema.customers, eq(schema.customerUsageSignals.customerId, schema.customers.id))
          .where(sql`${schema.customerUsageSignals.source} = 'rejig_api'
            AND ${schema.customerUsageSignals.signalType} = 'rejig.account_active'
            AND date(${schema.customerUsageSignals.observedAt}) = ${snap[0].d}
            AND ${schema.customerUsageSignals.signalValueNumeric} = 1`);
        for (const r of rows) rejigActive.add(norm(r.email));
        stripeStats.rejigSnapshot = snap[0].d;
      }
    }

    // Group/umbrella plans: any subscription id shared by 2+ LP customers and
    // still live in Stripe. Resolve these BEFORE deciding who churned, or every
    // seat-holder gets mislabelled as lapsed.
    const subIdCounts = new Map<string, number>();
    for (const c of customers) {
      const id = c.stripeSubscriptionId;
      if (id) subIdCounts.set(id, (subIdCounts.get(id) ?? 0) + 1);
    }
    const groupPlans = await findGroupPlans(
      [...subIdCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id),
    );
    const groupEmails = new Map<string, string>(); // customer email -> group sub id
    for (const c of customers) {
      const id = c.stripeSubscriptionId;
      if (id && groupPlans.has(id)) {
        groupEmails.set(norm(c.contactEmail), id);
        groupEmails.set(norm(c.platformEmail), id);
      }
    }
    for (const [id, g] of groupPlans) {
      const members = subIdCounts.get(id) ?? 0;
      stripeStats.groupPlans.push({ id, seats: g.seats, amount: g.amount, members });
      stripeStats.groupSeats += g.seats;
    }

    // Apply Stripe truth to every LP row: set what Stripe says, clear what it doesn't.
    for (const a of allAgents) {
      const truth = stateFor.get(a);
      if (truth) {
        if (a.subscriptionState !== truth) stripeStats.corrected++;
        a.subscriptionState = truth;
        continue;
      }
      // No individual sub. Before calling it churn, check for a group seat.
      if (groupEmails.has(norm(a.contactEmail))) {
        a.subscriptionState = 'Group plan';
        a.groupPlan = true;
        stripeStats.groupMembers++;
        continue;
      }
      // Still no subscription. Rejig separates the two very different cases:
      // an account we are actively serving without billing, versus one that is
      // gone. Absence from the latest full pull is the churn signal — the pull
      // returns inactive accounts too, so being *present* and flagged inactive
      // is not yet churn.
      if (rejigActive.has(a.contactEmail ? norm(a.contactEmail) : '')) {
        a.subscriptionState = 'Unbilled';
        a.unbilled = true;
        stripeStats.unbilled++;
      } else if (a.subscriptionState === 'Trial' || a.subscriptionState === 'Paying') {
        // LP claimed a live sub Stripe has no record of — the stale-mirror case.
        a.subscriptionState = 'No live sub';
        stripeStats.cleared++;
      }
    }
    stripeStats.groupUnresolved = Math.max(0, stripeStats.groupMembers - stripeStats.groupSeats);

    // Subscribers with no LP record at all: real adopted agents the funnel
    // never saw. Attribute by roster email, then roster name.
    const orphanByPerson = new Map<string, StripeSub>();
    for (const s of orphans) {
      const k = s.email || nameKey(s.name);
      const cur = orphanByPerson.get(k);
      if (!cur || (cur.state !== 'Paying' && s.state === 'Paying')) orphanByPerson.set(k, s);
    }
    for (const s of orphanByPerson.values()) {
      const hit = branchByEmail.get(s.email) ?? branchByName.get(nameKey(s.name));
      const target = hit ? branches.get(hit.key) : undefined;
      const agent: Agent = {
        branchKey: target?.branchKey ?? unattributed.branchKey,
        branchNo: target?.branchNo ?? '',
        branchName: target?.branchName ?? UNATTRIBUTED,
        name: s.name,
        contactEmail: s.email,
        phone: '',
        funnelStage: EXISTING,
        subscriptionState: s.state,
        monthlyAmount: s.plan,
        callDate: '',
        trialEndsOn: '',
        created: '',
        daysSinceCreated: 0,
        stuck: false,
        offRoster: !hit,
        createdVia: 'stripe',
        matchedBy: hit ? (branchByEmail.has(s.email) ? 'roster email' : 'roster name') : 'none',
        stripeOnly: true,
        groupPlan: false,
        unbilled: false,
      };
      (target ?? unattributed).agents.push(agent);
      stripeStats.added++;
    }

    for (const a of [...displayAll()]) {
      if (a.subscriptionState === 'Paying') stripeStats.paying++;
      else if (a.subscriptionState === 'Trial') stripeStats.trial++;
    }
  }

  function displayAll(): Agent[] {
    return [...[...branches.values()].flatMap((b) => b.agents), ...unattributed.agents];
  }

  // ---------- external taxonomy ----------
  // Internally the terminal buckets are about how someone ARRIVED (came through
  // onboarding vs pre-dated it). A brokerage cares about where they stand NOW,
  // so collapse those two on subscription reality instead. Rewriting the stage
  // in place keeps the summary, CSV, email and JSON on one taxonomy rather than
  // each re-deriving it and drifting.
  const SUBSCRIBED = 'Subscribed';
  const UNBILLED = 'Unbilled';
  const LAPSED = 'Lapsed';
  if (opts.external) {
    for (const a of displayAll()) {
      // A live subscription outranks whatever milestone LP recorded. The two
      // disagree when a sub was created outside the portal flow, or the payment
      // task never completed — and without this the agent lands on the
      // brokerage's push list as "Submitted, no card" while already paying.
      // It also keeps the Subscribed tile (paying + trial) equal to the
      // Subscribed bar, which are otherwise derived independently.
      if (a.subscriptionState === 'Paying' || a.subscriptionState === 'Trial') {
        a.funnelStage = SUBSCRIBED;
        continue;
      }
      if (a.funnelStage !== EXISTING && a.funnelStage !== 'Onboarded') continue;
      // 'Onboarded' vs 'Existing customer' records how WE created the row — came
      // through the landing page, or was imported retroactively. To the brokerage
      // both are simply live customers, and the onboarding-call column already
      // shows which is which. Collapse them.
      a.funnelStage = a.subscriptionState === 'Unbilled' ? UNBILLED : LAPSED;
    }
    const drop = new Set(['Onboarded', EXISTING]);
    const kept = labelOrder.filter((l) => !drop.has(l));
    labelOrder.length = 0;
    labelOrder.push(...kept, SUBSCRIBED, UNBILLED, LAPSED);
  }

  // ---------- ordering ----------
  const stageRank: Record<string, number> = Object.fromEntries(
    [SUBSCRIBED, EXISTING, 'Onboarded', UNBILLED, LAPSED, ...milestones.map((m) => m.bucketLabel).reverse(), STARTED_LABEL].map((s, i) => [s, i]),
  );
  const sortAgents = (as: Agent[]) =>
    as.sort(
      (a, b) =>
        (stageRank[a.funnelStage] ?? 99) - (stageRank[b.funnelStage] ?? 99) ||
        a.created.localeCompare(b.created) ||
        a.name.localeCompare(b.name),
    );

  let branchList = [...branches.values()];
  if (opts.branch) {
    const q = opts.branch.toLowerCase();
    branchList = branchList.filter(
      (b) => b.branchName.toLowerCase().includes(q) || b.branchNo.includes(q),
    );
  }
  for (const b of branchList) sortAgents(b.agents);
  sortAgents(unattributed.agents);
  // Biggest opportunity first: most agents in LP, then biggest roster.
  branchList.sort(
    (a, b) => b.agents.length - a.agents.length || b.rosterAgents - a.rosterAgents,
  );
  const displayBranches = opts.branch
    ? branchList
    : [...branchList, ...(unattributed.agents.length ? [unattributed] : [])];

  const branchLabel = (b: Branch) =>
    b.branchNo ? `${b.branchNo} — ${b.branchName}` : b.branchName;

  // ---------- summary rows ----------
  type SummaryRow = {
    branch: string;
    branchNo: string;
    branchName: string;
    branchKey: string;
    rosterAgents: number;
    inLp: number;
    pct: string;
    stages: Record<string, number>;
    trial: number;
    paying: number;
  };
  const summary: SummaryRow[] = displayBranches.map((b) => {
    const stages: Record<string, number> = Object.fromEntries(labelOrder.map((l) => [l, 0]));
    let trial = 0;
    let paying = 0;
    for (const a of b.agents) {
      stages[a.funnelStage] = (stages[a.funnelStage] ?? 0) + 1;
      if (a.subscriptionState === 'Trial') trial++;
      if (a.subscriptionState === 'Paying') paying++;
    }
    return {
      branch: branchLabel(b),
      branchNo: b.branchNo,
      branchName: b.branchName,
      branchKey: b.branchKey,
      rosterAgents: b.rosterAgents,
      inLp: b.agents.length,
      pct: b.rosterAgents ? `${((b.agents.length / b.rosterAgents) * 100).toFixed(1)}%` : '',
      stages,
      trial,
      paying,
    };
  });

  const totals = summary.reduce(
    (acc, s) => {
      acc.rosterAgents += s.rosterAgents;
      acc.inLp += s.inLp;
      acc.trial += s.trial;
      acc.paying += s.paying;
      for (const l of labelOrder) acc.stages[l] += s.stages[l] ?? 0;
      return acc;
    },
    {
      rosterAgents: 0,
      inLp: 0,
      trial: 0,
      paying: 0,
      stages: Object.fromEntries(labelOrder.map((l) => [l, 0])) as Record<string, number>,
    },
  );

  // ---------- headers ----------
  const today = new Date().toISOString().slice(0, 10);
  const internalHeader =
    `${brokerage.name} — LaunchPad funnel by branch` +
    ` · ${totals.inLp} agent(s) in LaunchPad of ${totals.rosterAgents} on roster` +
    `${opts.includeTest ? '' : ' (excluding test env)'}`;
  // Brokerage recipients get their own name and their own numbers — not our
  // product name, and not our test-environment caveat.
  const namedBranches = displayBranches.filter((b) => b.agents.length > 0);
  const externalHeader =
    namedBranches.length === 1 && opts.branch
      ? `Rejig at ${branchLabel(namedBranches[0])}`
      : `Rejig across ${brokerage.name}`;
  const header = opts.external ? externalHeader : internalHeader;
  // ---------- short labels + total row ----------
  const shortLabel: Record<string, string> = {
    [STARTED_LABEL]: 'Started',
    'Submitted, no card': 'No card',
    "Card saved, didn't book": 'Not booked',
    Booked: 'Booked',
    Onboarded: 'Onboarded',
    [EXISTING]: 'Existing',
  };
  const totalRow: SummaryRow = {
    branch: 'TOTAL',
    branchNo: '',
    branchName: 'TOTAL',
    branchKey: '',
    rosterAgents: totals.rosterAgents,
    inLp: totals.inLp,
    pct: totals.rosterAgents ? `${((totals.inLp / totals.rosterAgents) * 100).toFixed(1)}%` : '',
    stages: totals.stages,
    trial: totals.trial,
    paying: totals.paying,
  };

  // ---------- CSV (two joined files — never one flat denormalized file) ----------
  // ---------- CSV (two joined files — never one flat denormalized file) ----------
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const branchCsvCols = ['branch_id', 'branch_no', 'branch_name', 'roster_agents', 'in_launchpad', 'pct_of_roster', 'untouched', ...labelOrder, 'trial', 'paying'];
  const branchCsv =
    [branchCsvCols.map(esc).join(',')]
      .concat(
        summary.map((s) =>
          [
            s.branchKey,
            s.branchNo,
            s.branchName,
            s.rosterAgents,
            s.inLp,
            s.pct,
            s.rosterAgents ? Math.max(0, s.rosterAgents - s.inLp) : '',
            ...labelOrder.map((l) => s.stages[l] ?? 0),
            s.trial,
            s.paying,
          ].map(esc).join(','),
        ),
      )
      .join('\n') + '\n';

  const agentCsvCols = opts.external
    ? ['branch_no', 'branch_name', 'name', 'status', 'email', 'onboarding_call', 'first_seen']
    : [
        'branch_id', 'branch_no', 'branch_name', 'name', 'funnel_stage', 'subscription_state',
        'plan', 'call_date', 'trial_or_renewal_end', 'contact_email', 'phone', 'created',
        'days_since_created', 'stuck', 'created_via', 'branch_matched_by', 'off_roster',
      ];
  const agentCsv =
    [agentCsvCols.join(',')]
      .concat(
        displayBranches.flatMap((b) =>
          b.agents.map((a) =>
            (opts.external
              ? [a.branchNo, a.branchName, a.name, a.funnelStage, a.contactEmail, a.callDate, a.created]
              : [
                  b.branchKey, a.branchNo, a.branchName, a.name, a.funnelStage, a.subscriptionState,
                  a.monthlyAmount, a.callDate, a.trialEndsOn, a.contactEmail, a.phone, a.created,
                  a.daysSinceCreated, a.stuck, a.createdVia, a.matchedBy, a.offRoster,
                ]
            ).map(esc).join(','),
          ),
        ),
      )
      .join('\n') + '\n';

  const branchCsvName = `${opts.slug}-branches-${today}.csv`;
  const agentCsvName = `${opts.slug}-branch-agents-${today}.csv`;
  // ---------- JSON payload ----------
  const jsonPayload = {
      brokerage: brokerage.name,
      slug: opts.slug,
      workflowKey,
      generatedOn: today,
      subscriptionSource: opts.stripe ? 'stripe-live' : 'launchpad-mirror',
      stripeReconciliation: opts.stripe ? stripeStats : null,
      stageOrder: labelOrder,
      totals: {
        rosterAgents: totals.rosterAgents,
        inLaunchPad: totals.inLp,
        untouched: Math.max(0, totals.rosterAgents - totals.inLp),
        stages: totals.stages,
        trial: totals.trial,
        paying: totals.paying,
      },
      branches: displayBranches.map((b) => ({
        id: b.branchKey,
        no: b.branchNo,
        name: b.branchName,
        label: branchLabel(b),
        rosterAgents: b.rosterAgents,
        inLaunchPad: b.agents.length,
        agents: b.agents.map((a) => ({
          name: a.name,
          email: a.contactEmail,
          stage: a.funnelStage,
          subscriptionState: a.subscriptionState,
          plan: a.monthlyAmount,
          callDate: a.callDate,
          created: a.created,
          daysSinceCreated: a.daysSinceCreated,
          stuck: a.stuck,
          stripeOnly: a.stripeOnly,
          groupPlan: a.groupPlan,
          unbilled: a.unbilled,
        })),
      })),
    };

  return {
    brokerage: brokerage.name,
    slug: opts.slug,
    workflowKey,
    external: opts.external,
    stripeUsed: opts.stripe,
    today,
    header,
    internalHeader,
    externalHeader,
    labelOrder,
    shortLabel,
    unmapped,
    summary,
    totals,
    totalRow,
    branches: displayBranches,
    branchLabel,
    stripeStats,
    branchCsv,
    branchCsvName,
    agentCsv,
    agentCsvName,
    jsonPayload,
    maxRoster: Math.max(0, ...displayBranches.map((b) => b.rosterAgents)),
  };
}

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/**
 * The artifact's visuals, rebuilt for email.
 *
 * Email clients strip <script> and are unreliable with flexbox/grid/CSS vars,
 * so every chart here is a plain <table> with inline styles and percentage
 * widths — the only bar-chart technique that survives Outlook and Gmail alike.
 * Interaction (hover, sort, search) has no email equivalent and is simply gone;
 * what remains is the static read.
 */
const STAGE_INK: Record<string, { bg: string; on: string }> = {
  "Started, didn't submit":  { bg: '#CBDCCF', on: '#14241F' },
  'Submitted, no card':      { bg: '#8CC0A0', on: '#14241F' },
  "Card saved, didn't book": { bg: '#3FA37B', on: '#14241F' },
  'Booked':                  { bg: '#10795C', on: '#F7F3E5' },
  'Onboarded':               { bg: '#044439', on: '#F7F3E5' },
  'Existing customer':       { bg: '#B06A24', on: '#F7F3E5' },
  'Subscribed':              { bg: '#044439', on: '#F7F3E5' },
  'Unbilled':                { bg: '#8E4EA8', on: '#F7F3E5' },
  'Lapsed':                  { bg: '#5C6E75', on: '#F7F3E5' },
};

const STAGE_BLURB: Record<string, string> = {
  "Started, didn't submit":  'Began sign-up, never sent the form back',
  'Submitted, no card':      'Form in, payment method never saved',
  "Card saved, didn't book": 'Card on file, call never booked',
  'Booked':                  'Onboarding call scheduled',
  'Onboarded':               'Live on Rejig',
  'Existing customer':       'Was already with Rejig',
  'Subscribed':              'Live on Rejig \u2014 paying or on trial',
  'Unbilled':                'Account live, no subscription behind it',
  'Lapsed':                  'Had Rejig, no longer does',
};

function statTiles(cells: Array<{ n: string; l: string; s: string }>): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 0 26px -8px;">
    <tr>${cells
      .map(
        (c) => `<td style="width:25%;background:#fbf8ef;border:1px solid #e4dcc6;border-radius:4px;padding:14px 16px;vertical-align:top;">
          <div style="font-size:30px;line-height:1;color:#044439;font-weight:700;">${escHtml(c.n)}</div>
          <div style="font-size:12px;color:#4e6259;padding-top:5px;">${escHtml(c.l)}</div>
          <div style="font-size:11px;color:#7c8d85;padding-top:2px;">${c.s}</div>
        </td>`,
      )
      .join('')}</tr>
  </table>`;
}

function funnelBar(labelOrder: string[], stages: Record<string, number>, total: number): string {
  const shown = labelOrder.filter((l) => (stages[l] ?? 0) > 0);
  if (!shown.length || !total) return '';
  const cells = shown
    .map((l) => {
      const n = stages[l] ?? 0;
      const pct = (n / total) * 100;
      const ink = STAGE_INK[l] ?? { bg: '#5C6E75', on: '#F7F3E5' };
      const label = pct >= 7 ? String(n) : '';
      return `<td width="${pct.toFixed(2)}%" bgcolor="${ink.bg}" style="background:${ink.bg};color:${ink.on};font-size:11px;font-weight:700;text-align:center;padding:13px 0;">${label}</td>`;
    })
    .join('');
  const legend = labelOrder
    .map((l) => {
      const ink = STAGE_INK[l] ?? { bg: '#5C6E75', on: '#F7F3E5' };
      return `<tr>
        <td width="14" style="padding:5px 8px 5px 0;vertical-align:top;"><div style="width:11px;height:11px;border-radius:2px;background:${ink.bg};"></div></td>
        <td style="padding:5px 0;font-size:12px;color:#14241f;"><strong>${escHtml(l)}</strong>
          <span style="color:#4e6259;"> &mdash; ${escHtml(STAGE_BLURB[l] ?? '')}</span></td>
        <td style="padding:5px 0 5px 12px;font-size:13px;color:#14241f;text-align:right;font-weight:700;white-space:nowrap;">${stages[l] ?? 0}</td>
      </tr>`;
    })
    .join('');
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 14px 0;border-radius:3px;overflow:hidden;">
    <tr>${cells}</tr>
  </table>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 28px 0;">${legend}</table>`;
}

function branchBars(
  rows: Array<{ branch: string; rosterAgents: number; inLp: number; pct: string }>,
  maxRoster: number,
): string {
  const body = rows
    .map((r) => {
      const widthOfColumn = maxRoster ? (r.rosterAgents / maxRoster) * 100 : 0;
      const fill = r.rosterAgents ? (r.inLp / r.rosterAgents) * 100 : 0;
      const bar = `
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:${widthOfColumn.toFixed(2)}%;border-collapse:collapse;">
          <tr>
            ${fill > 0 ? `<td width="${Math.max(fill, 1.2).toFixed(2)}%" bgcolor="#044439" style="background:#044439;font-size:0;line-height:0;height:13px;">&nbsp;</td>` : ''}
            <td bgcolor="#ede5d2" style="background:#ede5d2;font-size:0;line-height:0;height:13px;">&nbsp;</td>
          </tr>
        </table>`;
      return `<tr>
        <td style="padding:5px 10px 5px 0;font-size:12.5px;color:#14241f;white-space:nowrap;">${escHtml(r.branch)}</td>
        <td style="padding:5px 0;width:100%;">${bar}</td>
        <td style="padding:5px 0 5px 12px;font-size:12px;color:#4e6259;text-align:right;white-space:nowrap;"><strong style="color:#14241f;">${r.inLp}</strong> / ${r.rosterAgents} &nbsp;<span style="color:#7c8d85;">${escHtml(r.pct)}</span></td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 28px 0;">${body}</table>`;
}

function buildEmailHtml(o: {
  header: string;
  today: string;
  labelOrder: string[];
  shortLabel: Record<string, string>;
  summary: Array<{ branch: string; rosterAgents: number; inLp: number; pct: string; stages: Record<string, number>; trial: number; paying: number }>;
  totalRow: { branch: string; rosterAgents: number; inLp: number; pct: string; stages: Record<string, number>; trial: number; paying: number };
  branches: Branch[];
  branchLabel: (b: Branch) => string;
  detail: boolean;
  slug: string;
  external: boolean;
  brokerage: string;
  totals: { rosterAgents: number; inLp: number; stages: Record<string, number>; trial: number; paying: number };
  maxRoster: number;
}): string {
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;';
  const tdR = `${td}text-align:right;`;
  const th = 'padding:6px 10px;border-bottom:2px solid #444;background:#f6f6f6;font-size:13px;text-align:left;';
  const thR = `${th}text-align:right;`;

  const sumHead =
    `<tr><th style="${th}">Branch</th><th style="${thR}">Roster</th><th style="${thR}">In LP</th><th style="${thR}">%</th><th style="${thR}">Untouched</th>` +
    o.labelOrder.map((l) => `<th style="${thR}">${escHtml(o.shortLabel[l] ?? l)}</th>`).join('') +
    `<th style="${thR}">Trial</th><th style="${thR}">Paying</th></tr>`;
  const sumRow = (s: (typeof o.summary)[number], bold = false) => {
    const b = bold ? 'font-weight:600;background:#fafafa;' : '';
    return (
      `<tr><td style="${td}${b}">${escHtml(s.branch)}</td><td style="${tdR}${b}">${s.rosterAgents || ''}</td>` +
      `<td style="${tdR}${b}">${s.inLp}</td><td style="${tdR}${b}">${escHtml(s.pct)}</td>` +
      `<td style="${tdR}${b}">${s.rosterAgents ? Math.max(0, s.rosterAgents - s.inLp) : ''}</td>` +
      o.labelOrder.map((l) => `<td style="${tdR}${b}">${s.stages[l] || ''}</td>`).join('') +
      `<td style="${tdR}${b}">${s.trial || ''}</td><td style="${tdR}${b}">${s.paying || ''}</td></tr>`
    );
  };
  const summaryTable = `<table style="border-collapse:collapse;width:100%;margin:0 0 28px 0;">${sumHead}${o.summary
    .map((s) => sumRow(s))
    .join('')}${sumRow(o.totalRow, true)}</table>`;

  const detailHtml = !o.detail
    ? ''
    : o.branches
        .filter((b) => b.agents.length > 0)
        .map(
          (b) => `
      <h3 style="margin:22px 0 8px 0;font-size:14px;">${escHtml(o.branchLabel(b))} <span style="font-weight:400;color:#666;">— ${b.agents.length} ${o.external ? 'raised a hand' : 'in LaunchPad'}${b.rosterAgents ? ` of ${b.rosterAgents} at this office` : ''}</span></h3>
      <table style="border-collapse:collapse;width:100%;">
        <tr><th style="${th}">Name</th><th style="${th}">${o.external ? 'Status' : 'Funnel Stage'}</th>${o.external ? '' : `<th style="${th}">Sub</th><th style="${th}">Plan</th>`}<th style="${th}">Onboarding call</th><th style="${th}">Email</th>${o.external ? '' : `<th style="${th}">Phone</th>`}<th style="${o.external ? th : thR}">${o.external ? 'Started' : 'Days'}</th></tr>
        ${b.agents
          .map(
            (a) => `<tr>
          <td style="${a.stuck ? `${td}background:${o.external ? '#fdf4e7' : '#fff5f5'};color:${o.external ? '#14241f' : '#a00'};font-weight:600;` : td}">${escHtml(a.name)}</td>
          <td style="${td}">${escHtml(a.funnelStage)}</td>
          ${o.external ? '' : `<td style="${td}">${escHtml(a.subscriptionState)}</td><td style="${td}">${escHtml(a.monthlyAmount)}</td>`}
          <td style="${td}">${escHtml(a.callDate)}</td>
          <td style="${td}">${escHtml(a.contactEmail)}</td>
          ${o.external ? '' : `<td style="${td}">${escHtml(a.phone)}</td>`}
          <td style="${o.external ? td : tdR}">${o.external ? escHtml(a.created) : a.daysSinceCreated}</td>
        </tr>`,
          )
          .join('')}
      </table>`,
        )
        .join('');

  // Gmail clips a message past ~102KB. A corporate-wide send with every agent
  // inline blows through that, so the roster moves to the attachment and the
  // email says so rather than silently truncating mid-table.
  const AGENT_INLINE_CAP = 60;
  const totalAgents = o.branches.reduce((n, b) => n + b.agents.length, 0);
  const showDetail = o.detail && (!o.external || totalAgents <= AGENT_INLINE_CAP);
  const detailSuppressed =
    o.detail && !showDetail
      ? `<div style="background:#fbf8ef;border:1px solid #e4dcc6;border-radius:4px;padding:12px 16px;font-size:13px;color:#4e6259;">
           All ${totalAgents} agents are listed by office in the attached spreadsheet.
         </div>`
      : '';

  // --- charts (external only; the internal report reads fine as plain tables)
  const reached = o.totals.inLp;
  const scoped = o.branches.filter((b) => b.agents.length > 0);
  const oneOffice = scoped.length === 1;

  let visualsHtml = '';
  if (o.external) {
    const stats = oneOffice
      ? [
          { n: String(scoped[0].agents.length), l: 'Raised a hand', s: `of ${scoped[0].rosterAgents} agents at this office` },
          { n: String(o.totals.paying + o.totals.trial), l: 'Subscribed', s: `${o.totals.paying} paying &middot; ${o.totals.trial} on trial` },
          { n: scoped[0].rosterAgents ? `${((scoped[0].agents.length / scoped[0].rosterAgents) * 100).toFixed(1)}%` : '', l: 'Of the office', s: 'have raised a hand' },
          { n: String(Math.max(0, scoped[0].rosterAgents - scoped[0].agents.length)), l: 'Not yet started', s: 'the push list' },
        ]
      : [
          { n: reached.toLocaleString('en-US'), l: 'Raised a hand', s: `of ${o.totals.rosterAgents.toLocaleString('en-US')} agents on the roster` },
          { n: String(o.totals.paying + o.totals.trial), l: 'Subscribed', s: `${o.totals.paying} paying &middot; ${o.totals.trial} on trial` },
          { n: o.totals.rosterAgents ? `${((reached / o.totals.rosterAgents) * 100).toFixed(1)}%` : '', l: 'Company-wide', s: `across ${o.summary.filter((x) => x.rosterAgents > 0).length} offices` },
          { n: Math.max(0, o.totals.rosterAgents - reached).toLocaleString('en-US'), l: 'Not yet started', s: 'the push list' },
        ];

    const stageTotals = oneOffice
      ? o.labelOrder.reduce<Record<string, number>>((acc, l) => {
          acc[l] = scoped[0].agents.filter((a) => a.funnelStage === l).length;
          return acc;
        }, {})
      : o.totals.stages;
    const stageSum = Object.values(stageTotals).reduce((a, b) => a + b, 0);

    visualsHtml =
      statTiles(stats) +
      `<h3 style="margin:0 0 10px 0;font-size:14px;color:#14241f;">Where they stand</h3>` +
      funnelBar(o.labelOrder, stageTotals, stageSum) +
      (oneOffice
        ? ''
        : `<h3 style="margin:0 0 10px 0;font-size:14px;color:#14241f;">Reach by office</h3>` +
          branchBars(
            // Bar length encodes office headcount, so order by it — ranked by
            // reach instead, the lengths jump around and the chart reads as noise.
            o.summary.filter((x) => x.rosterAgents > 0).slice().sort((a, b) => b.rosterAgents - a.rosterAgents),
            o.maxRoster,
          ));
  }


  const single = o.branches.filter((b) => b.agents.length > 0).length === 1
    ? o.branches.find((b) => b.agents.length > 0)!
    : null;

  const intro = o.external
    ? `<p style="font-size:14px;line-height:1.6;color:#33403a;margin:0 0 22px 0;max-width:64ch;">
         Every ${escHtml(o.brokerage)} agent who has taken a step toward Rejig${single ? ` at <strong>${escHtml(o.branchLabel(single))}</strong>` : ''} &mdash;
         from opening sign-up through to being live &mdash; and where each one stands today.
         Anyone shown as <strong>Started, didn't submit</strong> or <strong>Submitted, no card</strong> began sign-up and stopped
         partway; a nudge from the office is usually all it takes.${showDetail ? ' The same list is attached as a spreadsheet.' : ' The full list is attached as a spreadsheet.'}
       </p>`
    : '';

  const footer = o.external
    ? `<div style="font-size:11px;color:#8a9490;margin-top:28px;border-top:1px solid #e4dcc6;padding-top:12px;">
         Sent by the Rejig.ai success team &middot; questions to
         <a href="mailto:success@rejig.ai" style="color:#044439;">success@rejig.ai</a>
       </div>`
    : `<div style="font-size:11px;color:#888;margin-top:28px;border-top:1px solid #eee;padding-top:12px;">
         Rerun: <code>npx tsx scripts/branch-funnel-report.ts ${escHtml(o.slug)} --email ...</code>
       </div>`;

  const accent = o.external ? '#044439' : '#111';

  return `
<!doctype html>
<html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14241f;background:${o.external ? '#f7f3e5' : '#fff'};padding:24px;margin:0;">
  <div style="max-width:1100px;margin:0 auto;background:#fff;padding:${o.external ? '28px 32px' : '0'};border-radius:${o.external ? '4px' : '0'};">
  <h2 style="margin:0 0 6px 0;font-size:19px;color:${accent};">${escHtml(o.header)}</h2>
  <div style="font-size:12px;color:#7c8d85;margin:0 0 ${o.external ? '20px' : '18px'} 0;">${o.external ? 'Snapshot ' : 'Generated '}${escHtml(o.today)}</div>
  ${intro}
  ${visualsHtml}
  ${single || o.external ? '' : `<h3 style="margin:0 0 8px 0;font-size:14px;">By branch</h3>${summaryTable}`}
  ${showDetail ? `<h3 style="margin:0 0 8px 0;font-size:14px;">${o.external ? 'Your agents' : 'Per-agent detail'}</h3>${detailHtml}` : ''}
  ${detailSuppressed}
  ${footer}
  </div>
</body></html>`.trim();
}

export async function sendBranchReportEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachments: Array<{ filename: string; content: string }>;
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
    attachments: opts.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'utf8').toString('base64'),
    })),
  });
  if (result.error) throw new Error(`Resend error: ${result.error.message}`);
  return result.data;
}
/**
 * The brokerage-facing email for a computed report.
 *
 * `detail` controls whether the per-agent roster is inlined. Gmail clips a
 * message past ~102KB, so a brokerage-wide send keeps the roster in the
 * attached CSV and only a single-office report is small enough to inline.
 */
export function renderBranchReportHtml(
  r: BranchReportResult,
  { detail = true }: { detail?: boolean } = {},
): string {
  return buildEmailHtml({
    header: r.header,
    today: r.today,
    labelOrder: r.labelOrder,
    shortLabel: r.shortLabel,
    summary: r.summary,
    totalRow: r.totalRow,
    branches: r.branches,
    branchLabel: r.branchLabel,
    detail,
    slug: r.slug,
    external: r.external,
    brokerage: r.brokerage,
    totals: r.totals,
    maxRoster: r.maxRoster,
  });
}

/** Default subject line, used when a caller does not override it. */
export function defaultBranchReportSubject(r: BranchReportResult): string {
  return r.external
    ? `${r.header} — ${r.today}`
    : `${r.brokerage} onboarding by branch — ${r.today}`;
}
