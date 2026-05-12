import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';
import {
  getCustomers,
  getTasksAssignedTo,
  getAllCoreTasks,
  getTeamMembers,
} from '@/lib/db';
import { readViewAs } from '@/lib/auth/view-as';
import type { Task, Customer, TeamMember } from '@/types';

const ACCOUNT_TASK_NAMES = new Set(['Create Customer Account', 'Send Credentials']);

type Urgency = 'overdue' | 'urgent' | 'soon' | 'normal' | 'none';

function classifyCall(callDateIso: string): {
  daysUntil: number | null;
  label: string;
  urgency: Urgency;
} {
  if (!callDateIso) {
    return { daysUntil: null, label: 'No call scheduled', urgency: 'none' };
  }
  const callDate = new Date(callDateIso);
  if (Number.isNaN(callDate.getTime())) {
    return { daysUntil: null, label: 'Invalid date', urgency: 'none' };
  }
  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(callDate) - startOfDay(now)) / (1000 * 60 * 60 * 24),
  );

  let label: string;
  if (dayDiff === 0) label = 'today';
  else if (dayDiff === 1) label = 'tomorrow';
  else if (dayDiff === -1) label = 'yesterday';
  else if (dayDiff < 0) label = `${Math.abs(dayDiff)}d ago`;
  else label = `in ${dayDiff}d`;

  let urgency: Urgency;
  if (dayDiff < 0) urgency = 'overdue';
  else if (dayDiff < 1) urgency = 'urgent';
  else if (dayDiff <= 2) urgency = 'soon';
  else urgency = 'normal';

  return { daysUntil: dayDiff, label, urgency };
}

function urgencyClass(urgency: Urgency): string {
  switch (urgency) {
    case 'overdue':
    case 'urgent':
      return 'text-[#EC531A] font-semibold';
    case 'soon':
      return 'text-[#D97706] font-medium';
    case 'normal':
      return 'text-[#1B2E35]/60';
    default:
      return 'text-[#1B2E35]/40';
  }
}

type Row = {
  task: Task;
  customer: Customer | undefined;
  assigneeNames: string;
  call: ReturnType<typeof classifyCall>;
};

function TaskCard({ row, showAssignees }: { row: Row; showAssignees: boolean }) {
  const { task, customer, call, assigneeNames } = row;
  const customerId = task.customer[0] ?? '';
  return (
    <Link
      href={`/workspace/customers/${customerId}?taskId=${task.id}`}
      className="block rounded-lg border border-[#E0DEE4] bg-white p-3 hover:border-[#6C4AB6] hover:shadow-sm transition-all"
    >
      <p className="text-sm font-medium text-[#1B2E35] line-clamp-1">
        {customer?.name ?? 'Unknown'}
      </p>
      <p className="text-xs text-[#1B2E35]/60 line-clamp-1 mt-0.5">
        {customer?.businessName || '—'}
      </p>
      {showAssignees && (
        <p className="text-xs text-[#1B2E35]/50 line-clamp-1 mt-0.5">
          → {assigneeNames || 'unassigned'}
        </p>
      )}
      <div className="flex items-center justify-between mt-2 text-xs">
        <span className="inline-flex items-center rounded-full bg-[#F7F4EB] px-2 py-0.5 text-[#1B2E35]/70">
          📞 {customer?.callDate ? call.label : 'no call'}
        </span>
        {customer?.callDate && (
          <span className={urgencyClass(call.urgency)}>
            {call.urgency === 'urgent' || call.urgency === 'overdue'
              ? 'urgent'
              : call.urgency === 'soon'
                ? 'soon'
                : ''}
          </span>
        )}
      </div>
    </Link>
  );
}

function Column({
  title,
  emoji,
  rows,
  showAssignees,
  emptyMessage,
}: {
  title: string;
  emoji: string;
  rows: Row[];
  showAssignees: boolean;
  emptyMessage: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[#1B2E35]">
          <span className="mr-1.5">{emoji}</span>
          {title}
        </h2>
        <span className="text-xs text-[#1B2E35]/50">{rows.length}</span>
      </div>
      <div className="space-y-2 min-h-[60px]">
        {rows.length === 0 ? (
          <p className="text-xs text-[#1B2E35]/40 italic px-3 py-4 rounded-lg border border-dashed border-[#E0DEE4]">
            {emptyMessage}
          </p>
        ) : (
          rows.map((r) => (
            <TaskCard key={r.task.id} row={r} showAssignees={showAssignees} />
          ))
        )}
      </div>
    </div>
  );
}

// Role gate — Account Creator queue. Admin allowed (overview).
const ALLOWED_ROLES = new Set(['Account Creator', 'Admin']);

export default async function AccountQueuePage() {
  const session = await requireSession();
  const [ctx, view] = await Promise.all([getEffectiveContext(session), readViewAs()]);

  if (!ALLOWED_ROLES.has(ctx.role)) {
    redirect('/workspace');
  }

  const isAdminBroadView = session.role === 'Admin' && view.kind !== 'member';

  const [tasks, customers, members] = await Promise.all([
    isAdminBroadView
      ? getAllCoreTasks(['Active'])
      : getTasksAssignedTo(ctx.memberId, ['Active']),
    getCustomers(),
    getTeamMembers(),
  ]);

  const customerMap = new Map<string, Customer>(customers.map((c) => [c.id, c]));
  const memberMap = new Map<string, TeamMember>(members.map((m) => [m.id, m]));

  const filtered = tasks.filter((t) => ACCOUNT_TASK_NAMES.has(t.taskName));

  const rows: Row[] = filtered.map((task) => {
    const cId = task.customer[0];
    const customer = cId ? customerMap.get(cId) : undefined;
    const call = classifyCall(customer?.callDate ?? '');
    const assigneeNames = task.assignedTo
      .map((id) => memberMap.get(id)?.name?.split(' ')[0] ?? id)
      .join(', ');
    return { task, customer, call, assigneeNames };
  });

  // Sort by call date ASC; nulls last; urgent always at top.
  rows.sort((a, b) => {
    const ad = a.customer?.callDate ?? '';
    const bd = b.customer?.callDate ?? '';
    if (!ad && !bd) return 0;
    if (!ad) return 1;
    if (!bd) return -1;
    return ad.localeCompare(bd);
  });

  const createRows = rows.filter((r) => r.task.taskName === 'Create Customer Account');
  const sendRows = rows.filter((r) => r.task.taskName === 'Send Credentials');

  // Visual urgency split: pull urgent ones into separate column for visibility
  const urgent = rows.filter(
    (r) => r.call.urgency === 'urgent' || r.call.urgency === 'overdue',
  );

  const heading = isAdminBroadView
    ? 'Account Queue'
    : view.kind === 'member'
      ? `${ctx.label}'s Queue`
      : 'My Queue';

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#1B2E35]">{heading}</h1>
          <p className="text-sm text-[#1B2E35]/60 mt-1">
            {rows.length} active task{rows.length === 1 ? '' : 's'}
            {isAdminBroadView && ' (all assignees)'} · sorted by call date
          </p>
        </div>
        <p className="text-xs text-[#1B2E35]/50 max-w-xs text-right">
          Accounts must exist before the onboarding call.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Column
          title="Urgent"
          emoji="🚨"
          rows={urgent}
          showAssignees={isAdminBroadView}
          emptyMessage="Nothing urgent"
        />
        <Column
          title="Create Account"
          emoji="🆕"
          rows={createRows}
          showAssignees={isAdminBroadView}
          emptyMessage="No accounts to create"
        />
        <Column
          title="Send Credentials"
          emoji="🔑"
          rows={sendRows}
          showAssignees={isAdminBroadView}
          emptyMessage="No credentials to send"
        />
      </div>
    </div>
  );
}
