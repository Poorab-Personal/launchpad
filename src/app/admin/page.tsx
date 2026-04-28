import Link from 'next/link';
import { getCustomers, getTeamMembers, getAvailableWorkflows } from '@/lib/airtable';
import CustomerFilters from './customer-filters';
import AddCustomerForm from './add-customer-form';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  let customers = await getCustomers();
  const [teamMembers, workflows] = await Promise.all([
    getTeamMembers(),
    getAvailableWorkflows(),
  ]);
  const memberNameMap = new Map(teamMembers.map((m) => [m.id, m.name]));

  if (type) {
    customers = customers.filter((c) => c.type === type);
  }

  return (
    <div>
      <h1 className="mb-6 font-[var(--font-outfit)] text-2xl font-bold text-[#1B2E35]">Customers</h1>
      <AddCustomerForm workflows={workflows} />
      <CustomerFilters />
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
            {customers.map((customer) => (
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
