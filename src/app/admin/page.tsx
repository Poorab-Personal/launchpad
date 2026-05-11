import Link from 'next/link';
import {
  getCustomers,
  getTeamMembers,
  getAvailableWorkflows,
  getActiveTasksByCustomer,
} from '@/lib/db';
import type { Task } from '@/types';
import CustomerFilters from './customer-filters';
import AddCustomerForm from './add-customer-form';

/**
 * Pick the most relevant Active task to show in the admin list. Same
 * heuristic the workspace customer-detail header uses: prefer a Team task
 * in the current stage (that's where the work is actually waiting), fall
 * back to any Active task in the current stage, then any Active task at
 * all. Returns null when nothing is active.
 */
function pickCurrentTask(tasks: Task[] | undefined, currentStage: string): Task | null {
  if (!tasks || tasks.length === 0) return null;
  const inStage = tasks.filter((t) => t.stage === currentStage);
  return (
    inStage.find((t) => t.taskType === 'Team') ??
    inStage[0] ??
    tasks[0] ??
    null
  );
}

/**
 * Days a task has been Active. Falls back to days since it was created if
 * Activated At wasn't set (older tasks pre-Activated-At backfill).
 */
function daysActive(task: Task): number {
  const start = task.activatedAt || task.createdAt;
  if (!start) return 0;
  const ms = Date.now() - new Date(start).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** 0–3d green, 4–7d yellow, 8+ red. Same buckets as the urgency colors elsewhere. */
function healthClass(days: number): string {
  if (days >= 8) return 'bg-[#EC531A]';
  if (days >= 4) return 'bg-[#DABA21]';
  return 'bg-[#05C68E]';
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; stage?: string; channel?: string }>;
}) {
  const { type, stage, channel } = await searchParams;
  const allCustomers = await getCustomers();
  const [teamMembers, workflows, activeTasksByCustomer] = await Promise.all([
    getTeamMembers(),
    getAvailableWorkflows(),
    getActiveTasksByCustomer(),
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

      <div className="overflow-x-auto rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514]">
        <table className="min-w-full divide-y divide-[#E0DEE4]">
          <thead className="bg-[#F7F4EB]">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Channel</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Current Stage</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Current Task</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">CSM Assigned</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Stage Entered At</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E0DEE4] bg-white">
            {customers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-[#1B2E35]/40">
                  No customers match the current filters.
                </td>
              </tr>
            ) : (
              customers.map((customer) => {
                const currentTask = pickCurrentTask(
                  activeTasksByCustomer.get(customer.id),
                  customer.currentStage,
                );
                const days = currentTask ? daysActive(currentTask) : 0;
                return (
                <tr key={customer.id} className="hover:bg-[#F7F4EB]/60 transition-colors">
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link href={`/admin/${customer.id}`} className="font-medium text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors">
                      {customer.name}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#1B2E35]/70">{customer.channel}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[#6C4AB6]/10 text-[#6C4AB6]">
                      {customer.type}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#1B2E35]/70">{customer.currentStage}</td>
                  <td className="px-4 py-3 text-sm">
                    {currentTask ? (
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${healthClass(days)}`} aria-hidden="true" />
                          <span className="text-[#1B2E35]">{currentTask.taskName}</span>
                        </div>
                        <div className="text-[11px] text-[#1B2E35]/50 ml-4">
                          {days === 0 ? 'today' : `${days}d active`}
                          {currentTask.taskType === 'Team' ? (
                            <span className="ml-1.5 text-[#1B2E35]/60">
                              · {currentTask.assignedTo.length > 0
                                ? currentTask.assignedTo.map((id) => memberNameMap.get(id) ?? id).join(', ')
                                : <span className="text-[#EC531A]">unassigned</span>}
                            </span>
                          ) : (
                            <span className="ml-1.5 text-[#1B2E35]/40 italic">· awaiting customer</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[#1B2E35]/40">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#1B2E35]/60">
                    {customer.csmAssigned.length > 0 ? memberNameMap.get(customer.csmAssigned[0]) ?? customer.csmAssigned[0] : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#1B2E35]/60">
                    {customer.stageEnteredAt ? new Date(customer.stageEnteredAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    <a href={`/r/${customer.id}`} target="_blank" className="text-[#05C68E] hover:text-[#04946A] font-medium transition-colors">
                      Portal &rarr;
                    </a>
                    <a href={`/r/${customer.id}?test=fill`} target="_blank" className="ml-3 text-[#6C4AB6]/70 hover:text-[#6C4AB6] text-xs transition-colors" title="Opens portal with auto-fill button enabled">
                      (test)
                    </a>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
