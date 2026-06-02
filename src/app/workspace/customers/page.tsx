import Link from 'next/link';
import { requireSession } from '@/lib/auth/dal';
import { getCustomers, getTeamMembers } from '@/lib/db';
import type { TeamMember } from '@/types';
import PortalLinkActions from './PortalLinkActions';
import { CallDateBadge } from '@/components/CallDateDisplay';

function stagePill(stage: string) {
  if (!stage) return <span className="text-[#1B2E35]/40">—</span>;
  if (stage === 'Done') {
    return (
      <span className="inline-flex items-center rounded-full bg-[#05C68E]/10 px-2 py-0.5 text-xs font-medium text-[#04946A]">
        {stage}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[#6C4AB6]/10 px-2 py-0.5 text-xs font-medium text-[#6C4AB6]">
      {stage}
    </span>
  );
}

export default async function CustomersPage() {
  await requireSession();
  const [customers, members] = await Promise.all([getCustomers(), getTeamMembers()]);

  const memberMap = new Map<string, TeamMember>(members.map((m) => [m.id, m]));

  const sorted = [...customers].sort((a, b) => {
    // Done last, then by stage entered desc
    if ((a.currentStage === 'Done') !== (b.currentStage === 'Done')) {
      return a.currentStage === 'Done' ? 1 : -1;
    }
    return (b.stageEnteredAt || '').localeCompare(a.stageEnteredAt || '');
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1B2E35]">All Customers</h1>
        <p className="text-sm text-[#1B2E35]/60 mt-1">
          {customers.length} total
        </p>
      </div>

      <div className="rounded-xl bg-white border border-[#E0DEE4] overflow-hidden">
        <table className="w-full">
          <thead className="bg-[#F7F4EB] border-b border-[#E0DEE4]">
            <tr>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Customer
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Type
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Stage
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                CSM
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Approval
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Onboarding Call
              </th>
              <th className="text-right text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Portal
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E0DEE4]">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[#1B2E35]/50">
                  No customers yet.
                </td>
              </tr>
            ) : (
              sorted.map((c) => (
                <tr key={c.id} className="hover:bg-[#F7F4EB]/50 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/workspace/customers/${c.id}`}
                      className="text-sm font-medium text-[#6C4AB6] hover:underline"
                    >
                      {c.name}
                    </Link>
                    <p className="text-xs text-[#1B2E35]/50 line-clamp-1">
                      {c.businessName || '—'}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm text-[#1B2E35]">
                    {c.type}
                    {c.channel && (
                      <span className="text-[#1B2E35]/50"> · {c.channel}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{stagePill(c.currentStage)}</td>
                  <td className="px-4 py-3 text-sm text-[#1B2E35]/70">
                    {c.csmAssigned.length === 0
                      ? '—'
                      : c.csmAssigned
                          .map((id) => memberMap.get(id)?.name?.split(' ')[0] ?? id)
                          .join(', ')}
                  </td>
                  <td className="px-4 py-3 text-sm text-[#1B2E35]/70">
                    {c.designApproval ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {c.callBooked && c.callDate ? (
                      <CallDateBadge callDateIso={c.callDate} />
                    ) : (
                      <span className="text-[#1B2E35]/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PortalLinkActions
                      accessToken={c.accessToken}
                      portalBaseUrl={c.portalBaseUrl || undefined}
                    />
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
