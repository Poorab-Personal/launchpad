import Link from 'next/link';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';
import {
  getCustomers,
  getTasksAssignedTo,
  getAllCoreTasks,
  getTeamMembers,
} from '@/lib/airtable';
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
  // Compare at the day level — strip time.
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(callDate) - startOfDay(now)) / (1000 * 60 * 60 * 24),
  );

  let label: string;
  if (dayDiff === 0) label = 'today';
  else if (dayDiff === 1) label = 'tomorrow';
  else if (dayDiff === -1) label = 'yesterday';
  else if (dayDiff < 0) label = `${Math.abs(dayDiff)} days ago`;
  else label = `in ${dayDiff} days`;

  let urgency: Urgency;
  if (dayDiff < 0) urgency = 'overdue';
  else if (dayDiff < 1) urgency = 'urgent';
  else if (dayDiff <= 2) urgency = 'soon';
  else urgency = 'normal';

  return { daysUntil: dayDiff, label, urgency };
}

function formatCallDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function urgencyChip(urgency: Urgency, label: string) {
  const styles: Record<Urgency, string> = {
    overdue: 'bg-[#EC531A]/10 text-[#EC531A] border-[#EC531A]/30',
    urgent: 'bg-[#EC531A]/10 text-[#EC531A] border-[#EC531A]/30',
    soon: 'bg-[#D97706]/10 text-[#D97706] border-[#D97706]/30',
    normal: 'bg-[#F7F4EB] text-[#1B2E35]/70 border-[#E0DEE4]',
    none: 'bg-[#F7F4EB] text-[#1B2E35]/40 border-[#E0DEE4]',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[urgency]}`}
    >
      {label}
    </span>
  );
}

type Row = {
  task: Task;
  customer: Customer | undefined;
  assigneeNames: string;
  call: ReturnType<typeof classifyCall>;
};

function TaskRow({ row, showAssignees }: { row: Row; showAssignees: boolean }) {
  const { task, customer, call } = row;
  const customerId = task.customer[0] ?? '';
  return (
    <Link
      href={`/workspace/customers/${customerId}?taskId=${task.id}`}
      className="grid grid-cols-12 items-center gap-3 px-4 py-3 hover:bg-[#F7F4EB] transition-colors"
    >
      <div className="col-span-4 min-w-0">
        <p className="text-sm font-medium text-[#6C4AB6] truncate">
          {customer?.name ?? 'Unknown customer'}
        </p>
        <p className="text-xs text-[#1B2E35]/50 truncate">
          {customer?.businessName || '—'}
        </p>
      </div>
      <div className="col-span-3 text-xs text-[#1B2E35]/70 truncate">
        {task.taskName}
      </div>
      <div className="col-span-3 min-w-0">
        {customer?.callDate ? (
          <div className="flex flex-col">
            <span className="text-xs text-[#1B2E35]">
              {formatCallDate(customer.callDate)}
            </span>
            {urgencyChip(call.urgency, call.label)}
          </div>
        ) : (
          <span className="text-xs text-[#1B2E35]/40 italic">No call scheduled</span>
        )}
      </div>
      <div className="col-span-2 text-right text-xs text-[#1B2E35]/50 truncate">
        {showAssignees ? row.assigneeNames || 'unassigned' : task.stage}
      </div>
    </Link>
  );
}

function Section({
  title,
  emoji,
  rows,
  showAssignees,
}: {
  title: string;
  emoji: string;
  rows: Row[];
  showAssignees: boolean;
}) {
  return (
    <section className="rounded-xl bg-white border border-[#E0DEE4] overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 bg-[#F7F4EB] border-b border-[#E0DEE4]">
        <h2 className="text-sm font-semibold text-[#1B2E35]">
          <span className="mr-1.5">{emoji}</span>
          {title}
        </h2>
        <span className="text-xs text-[#1B2E35]/50">
          {rows.length} task{rows.length === 1 ? '' : 's'}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="text-sm text-[#1B2E35]/40 italic px-4 py-6 text-center">
          Nothing here right now.
        </p>
      ) : (
        <div className="divide-y divide-[#E0DEE4]">
          <div className="grid grid-cols-12 gap-3 px-4 py-2 bg-[#F7F4EB]/40 text-[10px] font-semibold uppercase tracking-wide text-[#1B2E35]/50">
            <div className="col-span-4">Customer</div>
            <div className="col-span-3">Task</div>
            <div className="col-span-3">Onboarding Call</div>
            <div className="col-span-2 text-right">
              {showAssignees ? 'Assignee' : 'Stage'}
            </div>
          </div>
          {rows.map((r) => (
            <TaskRow key={r.task.id} row={r} showAssignees={showAssignees} />
          ))}
        </div>
      )}
    </section>
  );
}

export default async function AccountQueuePage() {
  const session = await requireSession();
  const [ctx, view] = await Promise.all([getEffectiveContext(session), readViewAs()]);

  // Admin (no impersonation) sees ALL such tasks.
  // Otherwise filter to the effective member.
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

  // Sort by call date ASC; nulls last.
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

  const heading = isAdminBroadView
    ? 'Account Creator Queue'
    : view.kind === 'member'
      ? `${ctx.label}'s Queue`
      : 'My Queue';

  const subline = isAdminBroadView
    ? `${rows.length} active account task${rows.length === 1 ? '' : 's'} (all assignees)`
    : `${rows.length} active account task${rows.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1B2E35]">{heading}</h1>
          <p className="text-sm text-[#1B2E35]/60 mt-1">{subline}</p>
        </div>
        <p className="text-xs text-[#1B2E35]/50 max-w-xs text-right">
          Sorted by onboarding call date — soonest first. Accounts must exist
          before the call.
        </p>
      </div>

      <Section
        title="Create Customer Account"
        emoji="🆕"
        rows={createRows}
        showAssignees={isAdminBroadView}
      />

      <Section
        title="Send Credentials"
        emoji="🔑"
        rows={sendRows}
        showAssignees={isAdminBroadView}
      />
    </div>
  );
}
