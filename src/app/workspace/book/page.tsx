import Link from 'next/link';
import { connection } from 'next/server';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';
import {
  getCustomers,
  getTeamMembers,
  getTeamMemberById,
  getUpcomingCallsForCSM,
  getTasksAssignedTo,
} from '@/lib/airtable';
import type { Customer, TeamMember, Call, Task } from '@/types';
import { customerHealth } from '@/lib/csm';
import BookFilter, { type CSMOption } from './BookFilter';
import { readBookFilter } from './actions';
import type { BookFilter as BookFilterType } from './filter';

const CSM_TASK_NAMES = new Set([
  'Mark Onboarding Call Complete',
  'Send Zoom Recording',
  'Send Follow-Up Email',
]);

const CALL_TYPE_ICON: Record<string, string> = {
  Onboarding: '🚀',
  'Check-In 1': '🤝',
  'Check-In 2': '📈',
  'Ad-hoc': '💬',
};

function startOfToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isToday(iso: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  return d >= today && d < tomorrow;
}

function isThisWeek(iso: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const inSevenDays = new Date(today);
  inSevenDays.setDate(today.getDate() + 7);
  return d >= tomorrow && d <= inSevenDays;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortDate(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function CallCard({
  call,
  customer,
  showDate,
}: {
  call: Call;
  customer?: Customer;
  showDate?: boolean;
}) {
  if (!customer) return null;
  const icon = CALL_TYPE_ICON[call.type] ?? '📞';
  return (
    <Link
      href={`/workspace/customers/${customer.id}`}
      className="block rounded-lg border border-[#E0DEE4] bg-white p-3 hover:border-[#6C4AB6] hover:shadow-sm transition-all"
    >
      <p className="text-sm font-medium text-[#1B2E35] line-clamp-1">
        {customer.name}
      </p>
      <p className="text-xs text-[#1B2E35]/60 line-clamp-1 mt-0.5">
        <span className="mr-1">{icon}</span>
        {call.type}
      </p>
      <p className="text-xs text-[#6C4AB6] mt-1.5">
        {showDate ? formatShortDate(call.scheduledDate) + ' · ' : ''}
        {formatTime(call.scheduledDate)}
      </p>
    </Link>
  );
}

function TaskCard({
  task,
  customer,
}: {
  task: Task;
  customer?: Customer;
}) {
  if (!customer) return null;
  return (
    <Link
      href={`/workspace/customers/${customer.id}?taskId=${task.id}`}
      className="block rounded-lg border border-[#E0DEE4] bg-white p-3 hover:border-[#6C4AB6] hover:shadow-sm transition-all"
    >
      <p className="text-sm font-medium text-[#1B2E35] line-clamp-1">
        {customer.name}
      </p>
      <p className="text-xs text-[#1B2E35]/60 line-clamp-1 mt-0.5">
        ✓ {task.taskName}
      </p>
      <p className="text-xs text-[#1B2E35]/50 mt-1.5">
        {task.stage}
      </p>
    </Link>
  );
}

function AtRiskCard({
  customer,
  reason,
  flag,
}: {
  customer: Customer;
  reason: string;
  flag: 'yellow' | 'red';
}) {
  const dot = flag === 'red' ? '🔴' : '🟡';
  return (
    <Link
      href={`/workspace/customers/${customer.id}`}
      className="block rounded-lg border border-[#E0DEE4] bg-white p-3 hover:border-[#6C4AB6] hover:shadow-sm transition-all"
    >
      <p className="text-sm font-medium text-[#1B2E35] line-clamp-1">
        {customer.name}
      </p>
      <p className="text-xs text-[#1B2E35]/60 line-clamp-2 mt-0.5">
        <span className="mr-1">{dot}</span>
        {reason}
      </p>
      <p className="text-xs text-[#1B2E35]/50 mt-1.5">
        {customer.currentStage || '—'}
      </p>
    </Link>
  );
}

function EmptyColumn({ label }: { label: string }) {
  return (
    <p className="text-xs text-[#1B2E35]/40 italic px-3 py-4 rounded-lg border border-dashed border-[#E0DEE4]">
      {label}
    </p>
  );
}

export default async function CSMQueuePage() {
  await connection();
  const session = await requireSession();
  const ctx = await getEffectiveContext(session);
  const filter: BookFilterType = await readBookFilter();

  // Resolve which member's book we're showing
  let targetMemberId: string | null = ctx.memberId;
  let scopeLabel = 'My Queue';

  if (filter.kind === 'all') {
    targetMemberId = null;
    scopeLabel = 'All CSMs';
  } else if (filter.kind === 'unassigned') {
    targetMemberId = null;
    scopeLabel = 'Unassigned';
  } else if (filter.kind === 'member') {
    targetMemberId = filter.memberId;
    const m = await getTeamMemberById(filter.memberId);
    scopeLabel = m ? `${m.name.split(' ')[0]}'s Queue` : "Member's Queue";
  } else if (ctx.isViewAs && ctx.role === 'CSM') {
    scopeLabel = `${ctx.label}'s Queue`;
  }

  const [allCustomers, allMembers, myTasks, myUpcomingCalls] = await Promise.all([
    getCustomers(),
    getTeamMembers(),
    targetMemberId
      ? getTasksAssignedTo(targetMemberId, ['Active'])
      : Promise.resolve([] as Task[]),
    targetMemberId
      ? getUpcomingCallsForCSM(targetMemberId, 14)
      : Promise.resolve([] as Call[]),
  ]);

  // Customers in scope based on filter
  let scopedCustomers: Customer[];
  if (filter.kind === 'all') {
    scopedCustomers = allCustomers;
  } else if (filter.kind === 'unassigned') {
    scopedCustomers = allCustomers.filter(
      (c) => c.csmAssigned.length === 0 && c.currentStage !== 'Done',
    );
  } else if (targetMemberId) {
    scopedCustomers = allCustomers.filter((c) =>
      c.csmAssigned.includes(targetMemberId!),
    );
  } else {
    scopedCustomers = [];
  }

  const customerMap = new Map<string, Customer>(
    allCustomers.map((c) => [c.id, c]),
  );

  // CSM tasks for the queue
  const csmTasks = myTasks.filter((t) => CSM_TASK_NAMES.has(t.taskName));

  // Bucketize calls
  const callsToday = myUpcomingCalls.filter(
    (c) => c.customer[0] && isToday(c.scheduledDate),
  );
  const callsThisWeek = myUpcomingCalls.filter(
    (c) => c.customer[0] && isThisWeek(c.scheduledDate),
  );

  // At-risk customers (yellow + red), only on scoped book
  const atRisk = scopedCustomers
    .map((c) => ({ customer: c, ...customerHealth(c) }))
    .filter((x) => x.flag !== 'green') as Array<{
      customer: Customer;
      flag: 'yellow' | 'red';
      reason: string;
    }>;

  const csmOptions: CSMOption[] = allMembers
    .filter(
      (m) =>
        (m.role === 'CSM' || m.role === 'Senior CSM') &&
        m.active &&
        m.id !== ctx.memberId,
    )
    .map((m) => ({ id: m.id, name: m.name }));

  // Cookie value for the BookFilter <select>
  let filterValue = 'my';
  if (filter.kind === 'all') filterValue = 'all';
  else if (filter.kind === 'unassigned') filterValue = 'unassigned';
  else if (filter.kind === 'member') filterValue = `member:${filter.memberId}`;

  const totalActiveCount =
    callsToday.length + callsThisWeek.length + csmTasks.length + atRisk.length;

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#1B2E35]">CSM Queue</h1>
          <p className="text-sm text-[#1B2E35]/60 mt-1">
            {scopeLabel} · {totalActiveCount} item{totalActiveCount === 1 ? '' : 's'}
          </p>
        </div>
        <BookFilter current={filterValue} csms={csmOptions} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Today */}
        <div className="flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#1B2E35]">
              <span className="mr-1.5">☀️</span>Today
            </h2>
            <span className="text-xs text-[#1B2E35]/50">{callsToday.length}</span>
          </div>
          <div className="space-y-2 min-h-[60px]">
            {callsToday.length === 0 ? (
              <EmptyColumn label="No calls today" />
            ) : (
              callsToday.map((call) => (
                <CallCard
                  key={call.id}
                  call={call}
                  customer={customerMap.get(call.customer[0])}
                />
              ))
            )}
          </div>
        </div>

        {/* This Week */}
        <div className="flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#1B2E35]">
              <span className="mr-1.5">📅</span>This Week
            </h2>
            <span className="text-xs text-[#1B2E35]/50">{callsThisWeek.length}</span>
          </div>
          <div className="space-y-2 min-h-[60px]">
            {callsThisWeek.length === 0 ? (
              <EmptyColumn label="No upcoming calls" />
            ) : (
              callsThisWeek.map((call) => (
                <CallCard
                  key={call.id}
                  call={call}
                  customer={customerMap.get(call.customer[0])}
                  showDate
                />
              ))
            )}
          </div>
        </div>

        {/* Action Items */}
        <div className="flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#1B2E35]">
              <span className="mr-1.5">✅</span>Action Items
            </h2>
            <span className="text-xs text-[#1B2E35]/50">{csmTasks.length}</span>
          </div>
          <div className="space-y-2 min-h-[60px]">
            {csmTasks.length === 0 ? (
              <EmptyColumn label="Nothing pending" />
            ) : (
              csmTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  customer={customerMap.get(task.customer[0])}
                />
              ))
            )}
          </div>
        </div>

        {/* At Risk */}
        <div className="flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#1B2E35]">
              <span className="mr-1.5">⚠️</span>At Risk
            </h2>
            <span className="text-xs text-[#1B2E35]/50">{atRisk.length}</span>
          </div>
          <div className="space-y-2 min-h-[60px]">
            {atRisk.length === 0 ? (
              <EmptyColumn label="All healthy" />
            ) : (
              atRisk.map((x) => (
                <AtRiskCard
                  key={x.customer.id}
                  customer={x.customer}
                  reason={x.reason}
                  flag={x.flag}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {scopedCustomers.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold text-[#1B2E35]/70 mb-3 uppercase tracking-wide">
            {scopeLabel} ({scopedCustomers.length} customer{scopedCustomers.length === 1 ? '' : 's'})
          </h2>
          <div className="rounded-xl bg-white border border-[#E0DEE4] overflow-hidden">
            <ul className="divide-y divide-[#E0DEE4]">
              {scopedCustomers
                .slice()
                .sort((a, b) =>
                  (b.stageEnteredAt || '').localeCompare(a.stageEnteredAt || ''),
                )
                .map((c) => {
                  const h = customerHealth(c);
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/workspace/customers/${c.id}`}
                        className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[#F7F4EB]/50 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[#1B2E35] line-clamp-1">
                            {c.name}
                          </p>
                          <p className="text-xs text-[#1B2E35]/50 line-clamp-1 mt-0.5">
                            {c.businessName || '—'}
                          </p>
                        </div>
                        <span
                          className={`text-xs ${
                            c.currentStage === 'Done'
                              ? 'text-[#04946A]'
                              : 'text-[#6C4AB6]'
                          }`}
                        >
                          {c.currentStage || '—'}
                        </span>
                        <span
                          aria-hidden
                          title={h.reason}
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{
                            backgroundColor:
                              h.flag === 'red'
                                ? '#EC531A'
                                : h.flag === 'yellow'
                                  ? '#D97706'
                                  : '#05C68E',
                          }}
                        />
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// Suppress unused-imports warning for TeamMember (used only via types)
export type { TeamMember };
