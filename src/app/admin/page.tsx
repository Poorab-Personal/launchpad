import Link from 'next/link';
import { getCustomers, getTeamMembers, getAvailableWorkflows } from '@/lib/airtable';
import CustomerFilters from './customer-filters';
import AddCustomerForm from './add-customer-form';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; stage?: string; channel?: string }>;
}) {
  const { type, stage, channel } = await searchParams;
  const allCustomers = await getCustomers();
  const [teamMembers, workflows] = await Promise.all([
    getTeamMembers(),
    getAvailableWorkflows(),
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
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">CSM Assigned</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Stage Entered At</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E0DEE4] bg-white">
            {customers.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[#1B2E35]/40">
                  No customers match the current filters.
                </td>
              </tr>
            ) : (
              customers.map((customer) => (
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
