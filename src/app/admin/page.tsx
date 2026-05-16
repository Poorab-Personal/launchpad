import Link from 'next/link';
import {
  getCustomers,
  getTeamMembers,
  getAvailableWorkflows,
  getActiveTasksByCustomer,
  getStuckCustomerSummary,
  STUCK_WORKFLOW_KEYS,
  type StuckThreshold,
} from '@/lib/db';
import CustomerFilters from './customer-filters';
import AddCustomerForm from './add-customer-form';
import CustomerListTable from './customer-list-table';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; stage?: string; channel?: string }>;
}) {
  const { type, stage, channel } = await searchParams;
  const allCustomers = await getCustomers();
  const [teamMembers, workflows, activeTasksByCustomer, stuckSummary] = await Promise.all([
    getTeamMembers(),
    getAvailableWorkflows(),
    getActiveTasksByCustomer(),
    getStuckCustomerSummary(),
  ]);
  const memberNameMap = new Map(teamMembers.map((m) => [m.id, m.name]));

  // Base filter: type + channel (affects both pipeline cards and table)
  let baseCustomers = allCustomers;
  if (type) baseCustomers = baseCustomers.filter((c) => c.type === type);
  if (channel) baseCustomers = baseCustomers.filter((c) => c.channel === channel);

  // Compute stage counts from base-filtered customers (before stage filter)
  const stageCounts: Record<string, number> = {};
  for (const c of baseCustomers) {
    const s = c.currentStage || 'Unknown';
    stageCounts[s] = (stageCounts[s] ?? 0) + 1;
  }

  // Unique channels for filter dropdown
  const uniqueChannels = [...new Set(allCustomers.map((c) => c.channel).filter(Boolean))].sort();

  // Further filter by stage for the table
  let customers = baseCustomers;
  if (stage) customers = customers.filter((c) => c.currentStage === stage);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-[var(--font-outfit)] text-2xl font-bold text-[#1B2E35]">Customers</h1>
        <span className="text-sm text-[#1B2E35]/40">{allCustomers.length} total</span>
      </div>

      <AddCustomerForm workflows={workflows} />

      <StuckCustomersTile summary={stuckSummary} />

      <CustomerFilters
        stageCounts={stageCounts}
        channels={uniqueChannels}
        totalCustomers={baseCustomers.length}
      />

      {/* Results count when filtered */}
      {(stage || type || channel) && (
        <div className="mb-3 text-xs text-[#1B2E35]/40">
          Showing {customers.length} customer{customers.length !== 1 ? 's' : ''}
          {stage && <span className="ml-1">in <span className="font-medium text-[#6C4AB6]">{stage}</span></span>}
          {type && <span className="ml-1">&middot; {type}</span>}
          {channel && <span className="ml-1">&middot; {channel}</span>}
        </div>
      )}

      <CustomerListTable
        customers={customers}
        memberNameMap={Object.fromEntries(memberNameMap)}
        activeTasksByCustomer={Object.fromEntries(activeTasksByCustomer)}
      />
    </div>
  );
}

/**
 * Tactical visibility tile: how many customers are stuck in pre-launch
 * stages > 3d / > 7d, grouped by workflow. Click-through opens the
 * /admin/stuck drill-down filtered to that (workflow, threshold) cell.
 *
 * Phase 4 BI rules will eventually supersede this with attention_reason-
 * driven UI; until those columns land this gives admin a quick lens
 * over the existing `stage_entered_at` column.
 */
function StuckCustomersTile({
  summary,
}: {
  summary: Awaited<ReturnType<typeof getStuckCustomerSummary>>;
}) {
  const buckets: { threshold: StuckThreshold; label: string; color: string; dot: string }[] = [
    { threshold: 3, label: 'Stuck >3 days', color: 'text-[#DABA21]', dot: 'bg-[#DABA21]' },
    { threshold: 7, label: 'Stuck >7 days', color: 'text-[#EC531A]', dot: 'bg-[#EC531A]' },
  ];

  const totalAcrossAll = buckets.reduce(
    (sum, b) =>
      sum + STUCK_WORKFLOW_KEYS.reduce((wf, wk) => wf + summary.counts[b.threshold][wk], 0),
    0,
  );

  return (
    <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white p-5 shadow-[0px_4px_12px_#1B2E3514]">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/54">
          Stuck Customers
        </h2>
        <span className="text-xs text-[#1B2E35]/40">
          pre-launch stages &middot; time in current stage
        </span>
      </div>

      {totalAcrossAll === 0 ? (
        <p className="text-sm text-[#1B2E35]/50">
          No customers are stuck beyond the 3-day threshold. Nice.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {buckets.map(({ threshold, label, color, dot }) => (
            <div
              key={threshold}
              className="rounded-md border border-[#E0DEE4] bg-[#F7F4EB]/40 p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`}
                  aria-hidden="true"
                />
                <h3 className={`text-sm font-semibold ${color}`}>{label}</h3>
              </div>
              <ul className="space-y-1">
                {STUCK_WORKFLOW_KEYS.map((wk) => {
                  const count = summary.counts[threshold][wk];
                  return (
                    <li
                      key={wk}
                      className="flex items-center justify-between text-sm"
                    >
                      <Link
                        href={`/admin/stuck?workflow=${encodeURIComponent(wk)}&threshold=${threshold}`}
                        className={`flex w-full items-center justify-between rounded px-2 py-1 transition-colors ${
                          count > 0
                            ? 'text-[#6C4AB6] hover:bg-[#6C4AB6]/5 hover:text-[#6C4AB6]'
                            : 'text-[#1B2E35]/40 hover:bg-[#F7F4EB]'
                        }`}
                      >
                        <span className="font-mono text-xs">{wk}</span>
                        <span className="font-medium">
                          {count} {count === 1 ? 'customer' : 'customers'}
                        </span>
                      </Link>
                    </li>
                  );
                })}
                {threshold === 7 && summary.keyesStuckWithoutCardCount > 0 && (
                  <li className="mt-1 border-t border-[#E0DEE4] pt-1">
                    <Link
                      href={`/admin/stuck?workflow=B2B-Keyes&threshold=7&noCard=1`}
                      className="flex w-full items-center justify-between rounded px-2 py-1 text-[#EC531A] hover:bg-[#EC531A]/5"
                    >
                      <span className="text-xs italic">
                        B2B-Keyes &middot; stuck without card
                      </span>
                      <span className="font-semibold">
                        {summary.keyesStuckWithoutCardCount}
                      </span>
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
