import Link from 'next/link';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';
import {
  getCustomers,
  getTeamMembers,
  getTeamMemberById,
  getUpcomingCallsForCSM,
} from '@/lib/airtable';
import type { Customer, TeamMember, Call } from '@/types';
import { customerHealth, daysSinceStageEntered } from '@/lib/csm';
import BookFilter, { type CSMOption } from './BookFilter';
import { readBookFilter } from './actions';
import type { BookFilter as BookFilterType } from './filter';

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

function HealthBadge({ flag, reason }: { flag: 'green' | 'yellow' | 'red'; reason: string }) {
  const map = {
    green: { color: 'bg-[#05C68E]/10 text-[#04946A]', dot: '🟢', label: 'On track' },
    yellow: { color: 'bg-[#D97706]/10 text-[#D97706]', dot: '🟡', label: 'Watch' },
    red: { color: 'bg-[#EC531A]/10 text-[#EC531A]', dot: '🔴', label: 'At risk' },
  } as const;
  const s = map[flag];
  return (
    <span
      title={reason}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.color}`}
    >
      <span aria-hidden>{s.dot}</span>
      <span className="hidden sm:inline">{s.label}</span>
    </span>
  );
}

function TypePill({ type, channel }: { type: string; channel: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[#F7F4EB] px-2 py-0.5 text-xs font-medium text-[#1B2E35]/70">
      {type}
      {channel && ` · ${channel}`}
    </span>
  );
}

function formatScheduled(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

/**
 * Pick which customers to show based on the cookie filter.
 */
function applyFilter(
  customers: Customer[],
  filter: BookFilterType,
  effectiveMemberId: string,
): { rows: Customer[]; targetMemberId: string | null } {
  if (filter.kind === 'all') {
    return { rows: customers, targetMemberId: null };
  }
  if (filter.kind === 'unassigned') {
    return {
      rows: customers.filter(
        (c) => c.csmAssigned.length === 0 && c.currentStage !== 'Done',
      ),
      targetMemberId: null,
    };
  }
  const targetId = filter.kind === 'member' ? filter.memberId : effectiveMemberId;
  return {
    rows: customers.filter((c) => c.csmAssigned.includes(targetId)),
    targetMemberId: targetId,
  };
}

function filterToCookieValue(filter: BookFilterType): string {
  if (filter.kind === 'my') return 'my';
  if (filter.kind === 'unassigned') return 'unassigned';
  if (filter.kind === 'all') return 'all';
  return `member:${filter.memberId}`;
}

export default async function BookPage() {
  const session = await requireSession();
  const ctx = await getEffectiveContext(session);

  const [filter, customers, members] = await Promise.all([
    readBookFilter(),
    getCustomers(),
    getTeamMembers(),
  ]);

  const memberMap = new Map<string, TeamMember>(members.map((m) => [m.id, m]));
  const activeCsms = members
    .filter((m) => m.role === 'CSM' && m.active)
    .sort((a, b) => a.name.localeCompare(b.name));

  const csmOptions: CSMOption[] = activeCsms.map((m) => ({ id: m.id, name: m.name }));

  const { rows, targetMemberId } = applyFilter(customers, filter, ctx.memberId);

  // Fetch upcoming calls. Use the dedicated CSM helper when filtering by a
  // single member's book; otherwise we need calls across all customers in
  // the rows — fetch per-customer in parallel.
  const callsByCustomer = new Map<string, Call[]>();
  if (targetMemberId) {
    const calls = await getUpcomingCallsForCSM(targetMemberId);
    for (const call of calls) {
      const cId = call.customer[0];
      if (!cId) continue;
      const arr = callsByCustomer.get(cId) ?? [];
      arr.push(call);
      callsByCustomer.set(cId, arr);
    }
  } else {
    // Aggregate upcoming across all CSMs by union of per-csm queries we know
    // about. For Unassigned/All modes this is best-effort: query upcoming for
    // every active CSM in parallel and merge.
    const callLists = await Promise.all(
      activeCsms.map((m) => getUpcomingCallsForCSM(m.id).catch(() => [])),
    );
    const seen = new Set<string>();
    for (const list of callLists) {
      for (const call of list) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        const cId = call.customer[0];
        if (!cId) continue;
        const arr = callsByCustomer.get(cId) ?? [];
        arr.push(call);
        callsByCustomer.set(cId, arr);
      }
    }
  }

  // Sort each customer's upcoming calls soonest-first
  for (const [, arr] of callsByCustomer) {
    arr.sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));
  }

  // Sort rows: customers with upcoming calls (soonest first), then by stageEnteredAt desc
  const sorted = [...rows].sort((a, b) => {
    const aCalls = callsByCustomer.get(a.id) ?? [];
    const bCalls = callsByCustomer.get(b.id) ?? [];
    const aNext = aCalls[0]?.scheduledDate || '';
    const bNext = bCalls[0]?.scheduledDate || '';
    if (aNext && bNext) return aNext.localeCompare(bNext);
    if (aNext && !bNext) return -1;
    if (!aNext && bNext) return 1;
    // No upcoming calls on either: sort by stage entered desc
    return (b.stageEnteredAt || '').localeCompare(a.stageEnteredAt || '');
  });

  // Heading
  let heading = 'My Book';
  if (filter.kind === 'unassigned') heading = 'Unassigned Customers';
  else if (filter.kind === 'all') heading = 'All Customers';
  else if (filter.kind === 'member') {
    const m = await getTeamMemberById(filter.memberId);
    heading = m ? `${m.name.split(' ')[0]}'s Book` : 'CSM Book';
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1B2E35]">{heading}</h1>
          <p className="text-sm text-[#1B2E35]/60 mt-1">
            {sorted.length} customer{sorted.length === 1 ? '' : 's'}
          </p>
        </div>
        <BookFilter current={filterToCookieValue(filter)} csms={csmOptions} />
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
                Health
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Days
              </th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/60 px-4 py-3">
                Next Call
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E0DEE4]">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-[#1B2E35]/50">
                  No customers match this filter.
                </td>
              </tr>
            ) : (
              sorted.map((c) => {
                const health = customerHealth(c);
                const days = daysSinceStageEntered(c);
                const nextCall = (callsByCustomer.get(c.id) ?? [])[0];
                const csmNames = c.csmAssigned
                  .map((id) => memberMap.get(id)?.name?.split(' ')[0] ?? null)
                  .filter(Boolean)
                  .join(', ');
                return (
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
                        {csmNames && filter.kind !== 'my' && (
                          <span className="ml-1 text-[#1B2E35]/40">· CSM: {csmNames}</span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <TypePill type={c.type} channel={c.channel} />
                    </td>
                    <td className="px-4 py-3">{stagePill(c.currentStage)}</td>
                    <td className="px-4 py-3">
                      <HealthBadge flag={health.flag} reason={health.reason} />
                    </td>
                    <td className="px-4 py-3 text-sm text-[#1B2E35]/70">
                      {days === null ? '—' : `${days}d`}
                    </td>
                    <td className="px-4 py-3 text-sm text-[#1B2E35]/70">
                      {nextCall ? (
                        <div>
                          <p className="text-[#1B2E35]">{nextCall.type}</p>
                          <p className="text-xs text-[#1B2E35]/50">
                            {formatScheduled(nextCall.scheduledDate)}
                          </p>
                        </div>
                      ) : (
                        <span className="text-[#1B2E35]/40">—</span>
                      )}
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
