import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { customerUsageSignals } from '@/db/schema/customerUsageSignals';
import {
  getCustomerById,
  getEventsForCustomer,
  getStateTransitionsForCustomer,
  getTasksForCustomer,
  getTeamMembers,
  getBrokerageById,
} from '@/lib/db';
import type { TaskStatus } from '@/types';
import { deleteCustomerAction, updateBillingRelationshipAction } from './actions';
import DeleteCustomerButton from './delete-customer-button';

const CHANGE_SOURCE_BADGE: Record<string, string> = {
  hubspot_workflow: 'bg-[#6C4AB6]/10 text-[#6C4AB6]',
  hubspot_csm_ui:   'bg-[#05C68E]/10 text-[#05C68E]',
  hubspot_api_other:'bg-[#1B2E35]/8 text-[#1B2E35]/60',
  lp_auto2:         'bg-[#DABA21]/10 text-[#DABA21]',
  lp_bi:            'bg-[#DABA21]/10 text-[#DABA21]',
  lp_admin:         'bg-[#EC531A]/10 text-[#EC531A]',
  stripe_webhook:   'bg-[#1B2E35]/8 text-[#1B2E35]/70',
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const statusColor: Record<TaskStatus, string> = {
  Draft: 'bg-[#E0DEE4]/50 text-[#1B2E35]/60',
  Active: 'bg-[#6C4AB6]/10 text-[#6C4AB6]',
  'In Review': 'bg-[#DABA21]/10 text-[#DABA21]',
  Completed: 'bg-[#05C68E]/10 text-[#05C68E]',
  Rejected: 'bg-[#EC531A]/10 text-[#EC531A]',
};

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const customer = await getCustomerById(customerId);

  if (!customer) {
    notFound();
  }

  const [tasks, teamMembers, stateTransitions, eventsLog, customerExtra, rejigSignals] = await Promise.all([
    getTasksForCustomer(customer.id),
    getTeamMembers(),
    getStateTransitionsForCustomer(customer.id, 25),
    getEventsForCustomer(customer.id, 25),
    // Fields the legacy mapper doesn't expose yet
    db.query.customers.findFirst({
      where: eq(customers.id, customer.id),
      columns: {
        billingRelationship: true,
        onboardingState: true,
        attentionReason: true,
        rejigUserId: true,
        createdVia: true,
      },
    }),
    // Latest Rejig signal of each rejig.* type for this customer
    (async () => {
      const rejigTypes = [
        'rejig.last_login',
        'rejig.days_since_last_post',
        'rejig.total_published_posts',
        'rejig.listing_count',
        'rejig.days_until_expiry',
        'rejig.account_active',
      ];
      const rows = await db
        .select({
          signalType: customerUsageSignals.signalType,
          observedAt: customerUsageSignals.observedAt,
          signalValueNumeric: customerUsageSignals.signalValueNumeric,
          signalValueJsonb: customerUsageSignals.signalValueJsonb,
        })
        .from(customerUsageSignals)
        .where(
          and(
            eq(customerUsageSignals.customerId, customer.id),
            inArray(customerUsageSignals.signalType, rejigTypes),
          ),
        )
        .orderBy(desc(customerUsageSignals.observedAt));
      const byType = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!byType.has(r.signalType)) byType.set(r.signalType, r);
      return byType;
    })(),
  ]);
  const memberNameMap = new Map(teamMembers.map((m) => [m.id, m.name]));
  const brokerageName = customer.type === 'B2B' && customer.brokerage.length > 0
    ? (await getBrokerageById(customer.brokerage[0]))?.name ?? ''
    : '';

  // Group tasks by product, then core tasks by stage
  const coreTasks = tasks.filter((t) => t.product === 'Core' || !t.product);
  const voiceTasks = tasks.filter((t) => t.product === 'Voice');
  const avatarTasks = tasks.filter((t) => t.product === 'Avatar');

  const coreStageMap = new Map<string, { order: number; tasks: typeof tasks }>();
  for (const task of coreTasks) {
    const existing = coreStageMap.get(task.stage);
    if (existing) {
      existing.tasks.push(task);
      if (task.stageOrder > existing.order) existing.order = task.stageOrder;
    } else {
      coreStageMap.set(task.stage, { order: task.stageOrder, tasks: [task] });
    }
  }
  const coreStages = [...coreStageMap.entries()]
    .sort((a, b) => a[1].order - b[1].order);
  const allCoreStageNames = coreStages.map(([name]) => name);
  const currentStageIdx = allCoreStageNames.indexOf(customer.currentStage);

  // Group addon tasks by stage within each product
  function groupByStage(addonTasks: typeof tasks) {
    const map = new Map<string, { order: number; tasks: typeof tasks }>();
    for (const task of addonTasks) {
      const existing = map.get(task.stage);
      if (existing) {
        existing.tasks.push(task);
        if (task.stageOrder > existing.order) existing.order = task.stageOrder;
      } else {
        map.set(task.stage, { order: task.stageOrder, tasks: [task] });
      }
    }
    return [...map.entries()].sort((a, b) => a[1].order - b[1].order);
  }

  return (
    <div>
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors">
        &larr; Back to customers
      </Link>

      {/* Customer hero */}
      {(() => {
        const state = customerExtra?.onboardingState ?? null;
        const attention = customerExtra?.attentionReason ?? null;
        const billing = customerExtra?.billingRelationship ?? 'paying';
        const stateBadgeClass: Record<string, string> = {
          Active: 'bg-[#05C68E]/12 text-[#05C68E] border-[#05C68E]/30',
          Watch: 'bg-[#DABA21]/15 text-[#A18A18] border-[#DABA21]/30',
          'At-Risk': 'bg-[#EC531A]/12 text-[#EC531A] border-[#EC531A]/30',
          Critical: 'bg-[#EC531A]/20 text-[#EC531A] border-[#EC531A]/40 font-bold',
          Churned: 'bg-[#1B2E35]/12 text-[#1B2E35]/60 border-[#1B2E35]/20',
          'On Hold': 'bg-[#1B2E35]/8 text-[#1B2E35]/50 border-[#1B2E35]/15',
          'Pre-Onboarding': 'bg-[#6C4AB6]/12 text-[#6C4AB6] border-[#6C4AB6]/25',
          'Onboarding Scheduled': 'bg-[#6C4AB6]/12 text-[#6C4AB6] border-[#6C4AB6]/25',
        };
        const stateClass = state ? stateBadgeClass[state] ?? 'bg-[#1B2E35]/8 text-[#1B2E35]/60 border-[#1B2E35]/15' : '';

        // Tenure (days since customer.createdAt)
        const tenureDays = Math.floor((Date.now() - new Date(customer.createdAt).getTime()) / 86400000);
        const tenureLabel = tenureDays < 30 ? `${tenureDays}d` : tenureDays < 365 ? `${Math.floor(tenureDays / 30)}mo` : `${(tenureDays / 365).toFixed(1)}y`;

        // Engagement quick-stats
        const sigLogin = rejigSignals.get('rejig.last_login');
        const loginJsonb = sigLogin?.signalValueJsonb as { lastLoginISO?: string | null; never?: boolean } | null;
        const lastLoginRel = loginJsonb?.never ? 'never' : loginJsonb?.lastLoginISO ? relativeTime(loginJsonb.lastLoginISO) : '—';

        const sigPosts = rejigSignals.get('rejig.total_published_posts');
        const totalPosts = sigPosts?.signalValueNumeric ?? '—';

        const sigDaysSincePost = rejigSignals.get('rejig.days_since_last_post');
        const daysSincePostJsonb = sigDaysSincePost?.signalValueJsonb as { neverPosted?: boolean } | null;
        const daysSincePostVal = daysSincePostJsonb?.neverPosted ? 'never' : sigDaysSincePost?.signalValueNumeric ? `${sigDaysSincePost.signalValueNumeric}d` : '—';

        const sigListings = rejigSignals.get('rejig.listing_count');
        const listings = sigListings?.signalValueNumeric ?? '—';

        const sigExpiry = rejigSignals.get('rejig.days_until_expiry');
        const daysUntilExpiryNum = sigExpiry?.signalValueNumeric ? Number(sigExpiry.signalValueNumeric) : null;
        const daysUntilExpiryLabel = daysUntilExpiryNum == null
          ? '—'
          : daysUntilExpiryNum < 0
          ? `expired ${-daysUntilExpiryNum}d ago`
          : daysUntilExpiryNum <= 14
          ? `${daysUntilExpiryNum}d ⚠`
          : `${daysUntilExpiryNum}d`;

        return (
          <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514]">
            {/* Top row — name + state + delete */}
            <div className="flex items-start justify-between gap-4 border-b border-[#E0DEE4]/60 p-5">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-3 flex-wrap">
                  <h1 className="font-[var(--font-outfit)] text-2xl font-bold text-[#1B2E35]">{customer.name}</h1>
                  {state && (
                    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-semibold ${stateClass}`}>
                      {state}
                    </span>
                  )}
                  <span className="inline-flex items-center rounded-md border border-[#1B2E35]/15 bg-white px-2 py-0.5 text-xs font-medium text-[#1B2E35]/70">
                    {billing}
                  </span>
                </div>
                <div className="text-sm text-[#1B2E35]/60">
                  {customer.businessName && <span>{customer.businessName}</span>}
                  {customer.businessName && <span className="mx-1.5 text-[#1B2E35]/30">·</span>}
                  <span>{customer.type}</span>
                  <span className="mx-1.5 text-[#1B2E35]/30">·</span>
                  <span>{customer.channel}</span>
                </div>
                {attention && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[#EC531A]/8 px-2 py-1 text-xs font-medium text-[#EC531A]">
                    📍 {attention}
                  </div>
                )}

                {/* Quick links — HubSpot, Stripe (IDs buried in href) */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {customer.hubspotContactId && (
                    <a
                      href={hubspotContactUrl(customer.hubspotContactId) ?? '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-[#FF7A59]/30 bg-[#FF7A59]/8 px-2.5 py-1 text-xs font-medium text-[#FF7A59] hover:bg-[#FF7A59]/15 transition-colors"
                    >
                      HubSpot Contact ↗
                    </a>
                  )}
                  {customer.hubspotTicketId && (
                    <a
                      href={hubspotTicketUrl(customer.hubspotTicketId) ?? '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-[#FF7A59]/30 bg-[#FF7A59]/8 px-2.5 py-1 text-xs font-medium text-[#FF7A59] hover:bg-[#FF7A59]/15 transition-colors"
                    >
                      HubSpot Ticket ↗
                    </a>
                  )}
                  {customer.stripeCustomerId && (
                    <a
                      href={stripeCustomerUrl(customer.stripeCustomerId) ?? '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-[#635BFF]/30 bg-[#635BFF]/8 px-2.5 py-1 text-xs font-medium text-[#635BFF] hover:bg-[#635BFF]/15 transition-colors"
                    >
                      Stripe ↗
                    </a>
                  )}
                  <a
                    href={`/r/${customer.accessToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-[#05C68E]/30 bg-[#05C68E]/8 px-2.5 py-1 text-xs font-medium text-[#05C68E] hover:bg-[#05C68E]/15 transition-colors"
                  >
                    Customer Portal ↗
                  </a>
                </div>
              </div>
              <form action={deleteCustomerAction}>
                <input type="hidden" name="id" value={customer.id} />
                <DeleteCustomerButton customerName={customer.name} />
              </form>
            </div>

            {/* Bottom row — key signals */}
            <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile label="Tenure" value={tenureLabel} />
              <StatTile label="Days until expiry" value={daysUntilExpiryLabel} warn={daysUntilExpiryNum != null && daysUntilExpiryNum <= 14} />
              <StatTile label="Last login" value={lastLoginRel} />
              <StatTile label="Posts" value={String(totalPosts)} />
              <StatTile label="Listings" value={String(listings)} />
              <StatTile label="Days since post" value={daysSincePostVal} />
            </div>
          </div>
        );
      })()}

      {/* Billing Relationship + Rejig Engagement */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-[#E0DEE4] bg-white p-5">
          <h2 className="mb-1 font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/60">
            Billing Relationship
          </h2>
          <p className="mb-3 text-xs text-[#1B2E35]/50">
            How we treat this customer billing-wise. Default is <b>paying</b>; set to <b>comped</b>{' '}
            for sponsor execs / free accounts (real users we don&apos;t charge), <b>internal_demo</b>{' '}
            for Rejig-internal accounts (BI cron skips these entirely).
          </p>
          <form action={updateBillingRelationshipAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={customer.id} />
            <select
              name="billing_relationship"
              defaultValue={customerExtra?.billingRelationship ?? 'paying'}
              className="rounded border border-[#E0DEE4] bg-white px-2 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none"
            >
              <option value="paying">paying</option>
              <option value="comped">comped</option>
              <option value="internal_demo">internal_demo</option>
            </select>
            <button
              type="submit"
              className="rounded bg-[#6C4AB6] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#6C4AB6]/90"
            >
              Save
            </button>
            {customerExtra?.createdVia === 'backfill' && (
              <span className="text-xs text-[#1B2E35]/40">Backfilled</span>
            )}
          </form>
        </div>

        <div className="rounded-lg border border-[#E0DEE4] bg-white p-5">
          <h2 className="mb-1 font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/60">
            Rejig Engagement
          </h2>
          <p className="mb-3 text-xs text-[#1B2E35]/50">
            Latest signals from the Rejig API snapshot. Updated by the weekly cron.
          </p>
          {rejigSignals.size === 0 ? (
            <p className="text-sm text-[#1B2E35]/50 italic">
              No signals yet — wait for next Rejig snapshot or backfill.
            </p>
          ) : (
            <dl className="divide-y divide-[#E0DEE4]/60 text-sm">
              {[
                ['rejig.last_login', 'Last login'],
                ['rejig.days_since_last_post', 'Days since last post'],
                ['rejig.total_published_posts', 'Total posts'],
                ['rejig.listing_count', 'Listings'],
                ['rejig.days_until_expiry', 'Days until expiry'],
                ['rejig.account_active', 'Account active'],
              ].map(([type, label]) => {
                const sig = rejigSignals.get(type);
                let displayVal = '—';
                if (sig) {
                  if (type === 'rejig.last_login') {
                    const j = sig.signalValueJsonb as { lastLoginISO?: string | null; never?: boolean } | null;
                    if (j?.never) displayVal = 'never';
                    else if (j?.lastLoginISO) {
                      const d = new Date(j.lastLoginISO);
                      displayVal = `${d.toLocaleDateString()} (${relativeTime(j.lastLoginISO)})`;
                    }
                  } else if (type === 'rejig.account_active') {
                    displayVal = sig.signalValueNumeric === '1' ? 'yes' : 'no';
                  } else if (type === 'rejig.days_since_last_post') {
                    const j = sig.signalValueJsonb as { neverPosted?: boolean } | null;
                    if (j?.neverPosted) displayVal = 'never posted';
                    else if (sig.signalValueNumeric != null) displayVal = `${sig.signalValueNumeric} days`;
                  } else if (type === 'rejig.days_until_expiry') {
                    if (sig.signalValueNumeric != null) {
                      const n = Number(sig.signalValueNumeric);
                      displayVal = n < 0 ? `expired ${-n}d ago` : `${n} days`;
                    }
                  } else {
                    if (sig.signalValueNumeric != null) displayVal = sig.signalValueNumeric;
                  }
                }
                return (
                  <div key={type} className="flex justify-between gap-2 py-1.5">
                    <dt className="text-[#1B2E35]/70">{label}</dt>
                    <dd className="text-[#1B2E35] font-medium tabular-nums">{displayVal}</dd>
                  </div>
                );
              })}
            </dl>
          )}
          {rejigSignals.size > 0 && (
            <p className="mt-3 text-[11px] text-[#1B2E35]/40">
              Snapshot at {(() => {
                const any = [...rejigSignals.values()][0];
                return any ? new Date(any.observedAt).toLocaleString() : 'unknown';
              })()}
            </p>
          )}
        </div>
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Type" value={customer.type} />
        <Field label="Channel" value={customer.channel} />
        <Field label="Contact Email" value={customer.contactEmail} />
        <Field label="Platform Email" value={customer.platformEmail} />
        <Field label="Phone" value={customer.phone} />
      </Section>

      {/* Business Info */}
      {(customer.businessName || customer.website || customer.bio) && (
        <Section title="Business Info">
          <Field label="Business Name" value={customer.businessName} />
          <Field label="Website" value={customer.website} />
          <Field label="Business Address" value={customer.businessAddress} />
          <Field label="Service Areas" value={customer.serviceAreas} />
          <Field label="Bio" value={customer.bio} />
          <Field label="License Number" value={customer.licenseNumber} />
        </Section>
      )}

      {/* Assets */}
      {(customer.agentPhoto.length > 0 || customer.businessLogo.length > 0 || customer.otherAssets.length > 0) && (
        <Section title="Assets">
          <Field label="Agent Photo" value={customer.agentPhoto.length > 0 ? `${customer.agentPhoto.length} file(s)` : ''} />
          <Field label="Business Logo" value={customer.businessLogo.length > 0 ? `${customer.businessLogo.length} file(s)` : ''} />
          <Field label="Other Assets" value={customer.otherAssets.length > 0 ? `${customer.otherAssets.length} file(s)` : ''} />
        </Section>
      )}

      {/* Payment (D2C only) — actual payment-related fields only */}
      {customer.type === 'D2C' && (customer.productTier || customer.paymentStatus) && (
        <Section title="Payment">
          <Field label="Product Tier" value={customer.productTier ?? ''} />
          <Field label="Payment Status" value={customer.paymentStatus ?? ''} />
        </Section>
      )}

      {/* IDs (collapsible) — debug/forensics only; primary nav lives in the hero */}
      {(customer.hubspotContactId || customer.stripeCustomerId || customer.stripeSubscriptionId || customer.hubspotDealId) && (
        <details className="mb-6 rounded-lg border border-[#E0DEE4] bg-white">
          <summary className="cursor-pointer px-5 py-3 text-xs font-medium uppercase tracking-wider text-[#1B2E35]/40 hover:text-[#1B2E35]/60">
            IDs (debug)
          </summary>
          <div className="px-5 pb-4">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 text-xs">
              <IdRow label="LaunchPad" value={customer.id} />
              <IdRow label="HubSpot Contact" value={customer.hubspotContactId} />
              <IdRow label="HubSpot Ticket" value={customer.hubspotTicketId} />
              <IdRow label="HubSpot Deal" value={customer.hubspotDealId} />
              <IdRow label="Stripe Customer" value={customer.stripeCustomerId} />
              <IdRow label="Stripe Sub Core" value={customer.stripeSubscriptionId} />
              <IdRow label="Stripe Sub Voice" value={customer.voiceStripeId} />
              <IdRow label="Stripe Sub Avatar" value={customer.avatarStripeId} />
            </dl>
          </div>
        </details>
      )}

      {/* Design (D2C only) */}
      {customer.type === 'D2C' && customer.designApproval && (
        <Section title="Design">
          <Field label="Design Approval" value={customer.designApproval} />
          <Field label="Design Feedback" value={customer.designFeedback} />
        </Section>
      )}

      {/* Enterprise (B2B only) */}
      {customer.type === 'B2B' && (
        <Section title="Enterprise">
          <Field label="Brokerage" value={brokerageName} />
        </Section>
      )}

      {/* Status — only show for mid-onboarding customers (skip for backfilled / Launched) */}
      {customer.currentStage !== 'Backfilled' && customer.currentStage !== 'Launched' && (
        <Section title="Onboarding Progress">
          <Field label="Current Stage" value={customer.currentStage} />
          <Field label="Stage Entered At" value={customer.stageEnteredAt ? new Date(customer.stageEnteredAt).toLocaleDateString() : ''} />
          <Field label="Account Created" value={customer.accountCreated ? 'Yes' : 'No'} />
          <Field label="Credentials Sent" value={customer.credentialsSent ? 'Yes' : 'No'} />
          <Field label="Call Booked" value={customer.callBooked ? 'Yes' : 'No'} />
          <Field label="Call Completed" value={customer.callCompleted ? 'Yes' : 'No'} />
          <Field label="CSM Assigned" value={customer.csmAssigned.length > 0 ? memberNameMap.get(customer.csmAssigned[0]) ?? customer.csmAssigned[0] : ''} />
        </Section>
      )}

      {/* Tasks grouped by stage */}
      <h2 className="mt-8 mb-4 font-[var(--font-outfit)] text-lg font-semibold text-[#1B2E35]">
        Tasks ({tasks.length})
      </h2>

      <div className="mb-8 space-y-4">
        {coreStages.map(([stageName, { tasks: stageTasks }], idx) => {
          const sorted = [...stageTasks].sort((a, b) => a.taskOrder - b.taskOrder);
          const completed = sorted.filter((t) => t.status === 'Completed').length;
          const active = sorted.filter((t) => t.status === 'Active' || t.status === 'In Review').length;
          const stageStatus = idx < currentStageIdx ? 'completed' : idx === currentStageIdx ? 'active' : 'upcoming';

          return (
            <div key={stageName} className="rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514] overflow-hidden">
              {/* Stage header */}
              <div className={`flex items-center justify-between px-5 py-3 border-b border-[#E0DEE4] ${
                stageStatus === 'active' ? 'bg-[#6C4AB6]/5' : stageStatus === 'completed' ? 'bg-[#05C68E]/5' : 'bg-[#F7F4EB]'
              }`}>
                <div className="flex items-center gap-2.5">
                  {stageStatus === 'completed' ? (
                    <svg className="h-4 w-4 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  ) : (
                    <span className={`inline-flex h-2.5 w-2.5 rounded-full ${
                      stageStatus === 'active' ? 'bg-[#6C4AB6]' : 'bg-[#E0DEE4]'
                    }`} />
                  )}
                  <h3 className="font-[var(--font-outfit)] text-sm font-semibold text-[#1B2E35]">{stageName}</h3>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    stageStatus === 'completed'
                      ? 'bg-[#05C68E]/10 text-[#05C68E]'
                      : stageStatus === 'active'
                        ? 'bg-[#6C4AB6]/10 text-[#6C4AB6]'
                        : 'bg-[#E0DEE4]/70 text-[#1B2E35]/40'
                  }`}>
                    {stageStatus === 'completed' ? 'Completed' : stageStatus === 'active' ? 'In Progress' : 'Upcoming'}
                  </span>
                </div>
                <span className="text-xs font-medium text-[#1B2E35]/40">
                  {completed}/{sorted.length} done
                </span>
              </div>

              {/* Task rows */}
              <div className="divide-y divide-[#E0DEE4]/60">
                {sorted.map((task) => (
                  <div key={task.id} className={`flex items-center gap-3 px-5 py-2.5 ${
                    task.status === 'Completed' ? 'bg-[#05C68E]/[0.03]' : ''
                  }`}>
                    {/* Status icon */}
                    {task.status === 'Completed' ? (
                      <svg className="h-4 w-4 shrink-0 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                    ) : task.status === 'Active' || task.status === 'In Review' ? (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="h-2 w-2 rounded-full bg-[#6C4AB6]" />
                      </span>
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="h-2 w-2 rounded-full border-[1.5px] border-[#E0DEE4]" />
                      </span>
                    )}

                    {/* Task name */}
                    <span className={`flex-1 min-w-0 text-sm truncate ${
                      task.status === 'Completed' ? 'text-[#1B2E35]/50' : 'text-[#1B2E35] font-medium'
                    }`}>
                      {task.taskName}
                      {task.hasTeamReview && (
                        <span className="ml-1.5 inline-flex rounded-full bg-[#DABA21]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#DABA21]">Review</span>
                      )}
                    </span>

                    {/* Type */}
                    <span className={`shrink-0 text-xs font-medium ${
                      task.taskType === 'Team' ? 'text-[#6C4AB6]' : 'text-[#05C68E]'
                    }`}>{task.taskType}</span>

                    {/* Status pill */}
                    <span className={`shrink-0 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[task.status]}`}>
                      {task.status}
                    </span>

                    {/* Assigned */}
                    <span className="shrink-0 w-24 text-xs text-[#1B2E35]/40 truncate text-right">
                      {task.assignedTo.length > 0 ? memberNameMap.get(task.assignedTo[0]) ?? '—' : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* Add-on product groups */}
        {[
          { label: 'Voice Add-On', tasks: voiceTasks },
          { label: 'Avatar Add-On', tasks: avatarTasks },
        ]
          .filter(({ tasks: t }) => t.length > 0)
          .map(({ label, tasks: addonTasks }) => {
            const stages = groupByStage(addonTasks);
            const totalCompleted = addonTasks.filter((t) => t.status === 'Completed').length;

            return (
              <div key={label} className="rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514] overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#E0DEE4] bg-[#6C4AB6]/5">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#6C4AB6]" />
                    <h3 className="font-[var(--font-outfit)] text-sm font-semibold text-[#1B2E35]">{label}</h3>
                    <span className="inline-flex rounded-full bg-[#6C4AB6]/10 px-2 py-0.5 text-[10px] font-medium text-[#6C4AB6]">
                      Add-On
                    </span>
                  </div>
                  <span className="text-xs font-medium text-[#1B2E35]/40">
                    {totalCompleted}/{addonTasks.length} done
                  </span>
                </div>

                {stages.map(([stageName, { tasks: stageTasks }]) => {
                  const sorted = [...stageTasks].sort((a, b) => a.taskOrder - b.taskOrder);
                  return (
                    <div key={stageName}>
                      <div className="px-5 py-1.5 bg-[#F7F4EB]/60 border-b border-[#E0DEE4]/60">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-[#1B2E35]/40">{stageName}</span>
                      </div>
                      <div className="divide-y divide-[#E0DEE4]/60">
                        {sorted.map((task) => (
                          <div key={task.id} className={`flex items-center gap-3 px-5 py-2.5 ${
                            task.status === 'Completed' ? 'bg-[#05C68E]/[0.03]' : ''
                          }`}>
                            {task.status === 'Completed' ? (
                              <svg className="h-4 w-4 shrink-0 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                              </svg>
                            ) : task.status === 'Active' || task.status === 'In Review' ? (
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <span className="h-2 w-2 rounded-full bg-[#6C4AB6]" />
                              </span>
                            ) : (
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <span className="h-2 w-2 rounded-full border-[1.5px] border-[#E0DEE4]" />
                              </span>
                            )}
                            <span className={`flex-1 min-w-0 text-sm truncate ${
                              task.status === 'Completed' ? 'text-[#1B2E35]/50' : 'text-[#1B2E35] font-medium'
                            }`}>{task.taskName}</span>
                            <span className={`shrink-0 text-xs font-medium ${
                              task.taskType === 'Team' ? 'text-[#6C4AB6]' : 'text-[#05C68E]'
                            }`}>{task.taskType}</span>
                            <span className={`shrink-0 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[task.status]}`}>
                              {task.status}
                            </span>
                            <span className="shrink-0 w-24 text-xs text-[#1B2E35]/40 truncate text-right">
                              {task.assignedTo.length > 0 ? memberNameMap.get(task.assignedTo[0]) ?? '—' : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>

      {/* Stage history + Events activity log */}
      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-[#E0DEE4] bg-white p-5">
          <h2 className="mb-1 font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/60">
            Stage history
          </h2>
          <p className="mb-3 text-xs text-[#1B2E35]/50">
            HubSpot ticket pipeline transitions. Mirrored via Phase 3 sync.
          </p>
          {stateTransitions.length === 0 ? (
            <p className="text-sm text-[#1B2E35]/50 italic">No transitions yet.</p>
          ) : (
            <ol className="divide-y divide-[#E0DEE4]/60 text-sm">
              {stateTransitions.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-[#1B2E35]">
                      {t.fromState ?? '(none)'} <span className="text-[#1B2E35]/40">→</span> {t.toState}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-[#1B2E35]/50">
                      <span>{relativeTime(t.changedAt)}</span>
                      {t.sourceDetail && (
                        <span className="truncate font-mono text-[#1B2E35]/40" title={t.sourceDetail}>
                          · {t.sourceDetail}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                      CHANGE_SOURCE_BADGE[t.changeSource] ?? 'bg-[#1B2E35]/8 text-[#1B2E35]/60'
                    }`}
                  >
                    {t.changeSource.replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="rounded-lg border border-[#E0DEE4] bg-white p-5">
          <h2 className="mb-1 font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/60">
            Activity log
          </h2>
          <p className="mb-3 text-xs text-[#1B2E35]/50">
            LaunchPad-side events: tasks completed, stage advances, design approvals, etc.
          </p>
          {eventsLog.length === 0 ? (
            <p className="text-sm text-[#1B2E35]/50 italic">No events yet.</p>
          ) : (
            <ol className="divide-y divide-[#E0DEE4]/60 text-sm">
              {eventsLog.map((e) => {
                const detailText = e.details == null
                  ? ''
                  : typeof e.details === 'string'
                    ? e.details
                    : JSON.stringify(e.details);
                return (
                  <li key={e.id} className="flex items-start justify-between gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[13px] font-medium text-[#1B2E35]">{e.eventType}</span>
                        <span className="shrink-0 text-[11px] text-[#1B2E35]/50">{relativeTime(e.createdAt)}</span>
                      </div>
                      {detailText && (
                        <div className="truncate font-mono text-[10px] text-[#1B2E35]/55" title={detailText}>
                          {detailText}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-[#1B2E35]/8 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[#1B2E35]/60">
                      {e.actorType}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function IdRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <dt className="text-[#1B2E35]/50">{label}</dt>
      <dd className="font-mono text-[11px] text-[#1B2E35]/70 truncate" title={value}>{value}</dd>
    </div>
  );
}

function StatTile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${warn ? 'border-[#EC531A]/30 bg-[#EC531A]/5' : 'border-[#E0DEE4] bg-[#F7F4EB]/40'}`}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-[#1B2E35]/50">{label}</div>
      <div className={`mt-0.5 font-[var(--font-outfit)] text-base font-bold ${warn ? 'text-[#EC531A]' : 'text-[#1B2E35]'}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white p-5 shadow-[0px_4px_12px_#1B2E3514]">
      <h2 className="mb-3 font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/54">{title}</h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
        {children}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium uppercase text-[#1B2E35]/40">{label}</dt>
      <dd className="text-sm text-[#1B2E35]">{value}</dd>
    </div>
  );
}

function LinkField({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string | null;
}) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium uppercase text-[#1B2E35]/40">{label}</dt>
      <dd className="text-sm text-[#1B2E35] truncate">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#6C4AB6] hover:text-[#6C4AB6]/80 hover:underline"
            title={value}
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

// HubSpot portal ID for Rejig (audit 2026-05-12, confirmed).
const HUBSPOT_PORTAL_ID = '44956899';

function hubspotContactUrl(id: string): string | null {
  if (!id) return null;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${id}`;
}

function hubspotDealUrl(id: string): string | null {
  if (!id) return null;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${id}`;
}

function hubspotTicketUrl(id: string): string | null {
  if (!id) return null;
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-5/${id}`;
}

// All backfilled customer Stripe IDs (cus_*, sub_*) live in Rejig's
// PRODUCTION Stripe account. Our STRIPE_SECRET_KEY is sk_test_ (Keyes
// Sandbox) because we use it for the new D2C/Keyes-trial setup-intent
// flow on the test side. So we can't infer the URL prefix from the key.
// Hardcode the Rejig production account anchor; if a customer's Stripe
// data is actually in the test sandbox the link will 404 (rare, only
// post-Keyes-Sandbox-cutover D2C customers).
const STRIPE_DASHBOARD_ACCOUNT = process.env.STRIPE_DASHBOARD_ACCOUNT_ID
  ?? 'acct_1MgW0DCQTlvKI2AN'; // Rejig production

function stripeCustomerUrl(id: string): string | null {
  if (!id) return null;
  return `https://dashboard.stripe.com/${STRIPE_DASHBOARD_ACCOUNT}/customers/${id}`;
}

function stripeSubscriptionUrl(id: string): string | null {
  if (!id) return null;
  return `https://dashboard.stripe.com/${STRIPE_DASHBOARD_ACCOUNT}/subscriptions/${id}`;
}
