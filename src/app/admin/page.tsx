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
      <h1 className="mb-6 text-2xl font-bold text-white">Customers</h1>
      <AddCustomerForm workflows={workflows} />
      <CustomerFilters />
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="min-w-full divide-y divide-gray-800">
          <thead className="bg-gray-900">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Channel</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Current Stage</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">CSM Assigned</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Stage Entered At</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-950">
            {customers.map((customer) => (
              <tr key={customer.id} className="hover:bg-gray-900">
                <td className="whitespace-nowrap px-4 py-3">
                  <Link href={`/admin/${customer.id}`} className="font-medium text-blue-400 hover:text-blue-300">
                    {customer.name}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-300">{customer.channel}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-300">{customer.type}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-300">{customer.currentStage}</td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-400">
                  {customer.csmAssigned.length > 0 ? memberNameMap.get(customer.csmAssigned[0]) ?? customer.csmAssigned[0] : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-400">
                  {customer.stageEnteredAt ? new Date(customer.stageEnteredAt).toLocaleDateString() : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm">
                  <a href={`/r/${customer.id}`} target="_blank" className="text-emerald-400 hover:text-emerald-300">
                    Portal
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
