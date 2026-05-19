'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Customer, Task } from '@/types';

const HS_PORTAL_ID = '44956899';

const STATE_BADGE: Record<string, string> = {
  Active: 'bg-[#05C68E]/12 text-[#05C68E] border-[#05C68E]/30',
  Watch: 'bg-[#DABA21]/15 text-[#A18A18] border-[#DABA21]/30',
  'At-Risk': 'bg-[#EC531A]/12 text-[#EC531A] border-[#EC531A]/30',
  Critical: 'bg-[#EC531A]/20 text-[#EC531A] border-[#EC531A]/40 font-bold',
  Churned: 'bg-[#1B2E35]/12 text-[#1B2E35]/60 border-[#1B2E35]/20',
  'On Hold': 'bg-[#1B2E35]/8 text-[#1B2E35]/50 border-[#1B2E35]/15',
  'Pre-Onboarding': 'bg-[#6C4AB6]/12 text-[#6C4AB6] border-[#6C4AB6]/25',
  'Onboarding Scheduled': 'bg-[#6C4AB6]/12 text-[#6C4AB6] border-[#6C4AB6]/25',
};

const STATE_ORDER = ['Critical', 'At-Risk', 'Watch', 'Active', 'Pre-Onboarding', 'Onboarding Scheduled', 'On Hold', 'Churned'];

function pickCurrentTask(tasks: Task[] | undefined, currentStage: string): Task | null {
  if (!tasks || tasks.length === 0) return null;
  const inStage = tasks.filter((t) => t.stage === currentStage);
  return inStage.find((t) => t.taskType === 'Team') ?? inStage[0] ?? tasks[0] ?? null;
}

function daysActive(task: Task): number {
  const start = task.activatedAt || task.createdAt;
  if (!start) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 86_400_000));
}

function healthClass(days: number): string {
  if (days >= 8) return 'bg-[#EC531A]';
  if (days >= 4) return 'bg-[#DABA21]';
  return 'bg-[#05C68E]';
}

interface Props {
  customers: Customer[];
  memberNameMap: Record<string, string>;
  activeTasksByCustomer: Record<string, Task[]>;
}

export default function CustomerListTable({ customers, memberNameMap, activeTasksByCustomer }: Props) {
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<string>('');

  const filteredCustomers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return customers.filter((c) => {
      if (stateFilter && (c.onboardingState ?? '') !== stateFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q)
        || c.contactEmail.toLowerCase().includes(q)
        || c.platformEmail.toLowerCase().includes(q)
        || (c.businessName ?? '').toLowerCase().includes(q)
      );
    });
  }, [customers, query, stateFilter]);

  const stateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of customers) {
      const s = c.onboardingState ?? '—';
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [customers]);

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search by name, email, or business…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-[#E0DEE4] bg-white px-3 py-2 pl-9 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]/30"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#1B2E35]/40">🔍</span>
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-md border border-[#E0DEE4] bg-white px-2 py-2 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none"
        >
          <option value="">All states</option>
          {STATE_ORDER.filter((s) => stateCounts.has(s)).map((s) => (
            <option key={s} value={s}>
              {s} ({stateCounts.get(s)})
            </option>
          ))}
        </select>
      </div>

      {(query || stateFilter) && (
        <div className="mb-2 text-xs text-[#1B2E35]/50">
          {filteredCustomers.length} of {customers.length} customer{customers.length !== 1 ? 's' : ''}
        </div>
      )}

      <div className="rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514]">
        <table className="w-full table-fixed divide-y divide-[#E0DEE4]">
          <thead className="bg-[#F7F4EB]">
            <tr>
              <th className="w-[28%] px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Name</th>
              <th className="w-[10%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Channel</th>
              <th className="w-[12%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">State</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">Current Task</th>
              <th className="w-[14%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54">CSM</th>
              <th className="w-[10%] px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-[#1B2E35]/54"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E0DEE4] bg-white">
            {filteredCustomers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-[#1B2E35]/40">
                  No customers match.
                </td>
              </tr>
            ) : (
              filteredCustomers.map((customer) => {
                const currentTask = pickCurrentTask(
                  activeTasksByCustomer[customer.id],
                  customer.currentStage,
                );
                const days = currentTask ? daysActive(currentTask) : 0;
                const state = customer.onboardingState;
                const stateClass = state ? STATE_BADGE[state] ?? 'bg-[#1B2E35]/8 text-[#1B2E35]/60 border-[#1B2E35]/15' : '';
                return (
                  <tr key={customer.id} className="hover:bg-[#F7F4EB]/60 transition-colors">
                    <td className="px-4 py-3 align-top">
                      <Link
                        href={`/admin/${customer.id}`}
                        className="font-medium text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors break-words"
                      >
                        {customer.name}
                      </Link>
                      <div className="text-[11px] text-[#1B2E35]/40 mt-0.5 truncate">
                        {customer.contactEmail}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-sm align-top">
                      <div className="text-[#1B2E35]/70">{customer.channel}</div>
                      <div className="text-[11px] text-[#1B2E35]/40 mt-0.5">{customer.type}</div>
                    </td>
                    <td className="px-3 py-3 text-sm align-top">
                      {state ? (
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${stateClass}`}>
                          {state}
                        </span>
                      ) : (
                        <span className="text-[#1B2E35]/40">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm align-top">
                      {currentTask ? (
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${healthClass(days)}`} aria-hidden="true" />
                            <span className="text-[#1B2E35] break-words">{currentTask.taskName}</span>
                          </div>
                          <div className="text-[11px] text-[#1B2E35]/50 ml-4">
                            {days === 0 ? 'today' : `${days}d active`}
                            {currentTask.taskType === 'Team' ? (
                              <span className="ml-1.5 text-[#1B2E35]/60">
                                · {currentTask.assignedTo.length > 0
                                  ? currentTask.assignedTo.map((id) => memberNameMap[id] ?? id).join(', ')
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
                    <td className="px-3 py-3 text-sm text-[#1B2E35]/60 align-top break-words">
                      {customer.csmAssigned.length > 0 ? memberNameMap[customer.csmAssigned[0]] ?? customer.csmAssigned[0] : '—'}
                    </td>
                    <td className="px-3 py-3 text-sm align-top">
                      <div className="flex items-center gap-2">
                        {customer.hubspotTicketId && (
                          <a
                            href={`https://app.hubspot.com/contacts/${HS_PORTAL_ID}/record/0-5/${customer.hubspotTicketId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#FF7A59] hover:text-[#FF7A59]/80 transition-colors text-xs"
                            title="Open HubSpot ticket"
                          >
                            HS↗
                          </a>
                        )}
                        <a
                          href={`/r/${customer.accessToken}`}
                          target="_blank"
                          className="text-[#05C68E] hover:text-[#04946A] font-medium transition-colors text-xs"
                        >
                          Portal &rarr;
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
