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
import { CallDateBadge } from '@/components/CallDateDisplay';

type Column = {
  key: string;
  title: string;
  emoji: string;
  match: (taskName: string) => boolean;
};

const COLUMNS: Column[] = [
  {
    key: 'design',
    title: 'To Design',
    emoji: '🎨',
    // "Revise Design (Round N)" = customer-driven revision; "Revise Design (Internal Round N)" = senior-driven
    match: (n) => n === 'Create Designs' || /^Revise Design \((Internal )?Round/i.test(n),
  },
  {
    key: 'review',
    title: 'To Review',
    emoji: '👀',
    match: (n) => n === 'Review Designs' || /^Review Revision \(Round/i.test(n),
  },
  {
    key: 'send',
    title: 'To Send',
    emoji: '📤',
    match: (n) =>
      n === 'Upload Proof to Customer' || /^Upload Revised Proof \(Round/i.test(n),
  },
  {
    key: 'deploy',
    title: 'To Deploy',
    emoji: '🚀',
    match: (n) => n === 'Move Designs to Production',
  },
];

function bucketize(tasks: Task[]): { columns: Map<string, Task[]>; other: Task[] } {
  const columns = new Map<string, Task[]>();
  for (const c of COLUMNS) columns.set(c.key, []);
  const other: Task[] = [];
  for (const t of tasks) {
    const col = COLUMNS.find((c) => c.match(t.taskName));
    if (col) columns.get(col.key)!.push(t);
    else other.push(t);
  }
  return { columns, other };
}

function urgencyClass(days: number | null): string {
  if (days === null) return 'text-[#1B2E35]/40';
  if (days >= 5) return 'text-[#EC531A] font-semibold';
  if (days >= 3) return 'text-[#D97706] font-medium';
  return 'text-[#1B2E35]/60';
}

function workflowLabel(channel: string): string {
  return channel === 'Standard' ? 'D2C' : channel;
}

function TaskCard({
  task,
  customerName,
  customerId,
  customerChannel,
  callDateIso,
  assignees,
}: {
  task: Task;
  customerName: string;
  customerId: string;
  customerChannel?: string;
  callDateIso?: string;
  assignees?: string;
}) {
  return (
    <Link
      href={`/workspace/customers/${customerId}?taskId=${task.id}`}
      className="block rounded-lg border border-[#E0DEE4] bg-white p-3 hover:border-[#6C4AB6] hover:shadow-sm transition-all"
    >
      <p className="text-sm font-medium text-[#1B2E35] line-clamp-1">
        {customerName}
      </p>
      <p className="text-xs text-[#1B2E35]/60 line-clamp-1 mt-0.5">
        {task.taskName}
      </p>
      {assignees && (
        <p className="text-xs text-[#1B2E35]/50 line-clamp-1 mt-0.5">
          → {assignees}
        </p>
      )}
      <div className="flex items-center justify-between mt-2 text-xs">
        <div className="flex items-center gap-1.5">
          {customerChannel && (
            <span className="inline-flex items-center rounded-full border border-[#1B2E35]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#1B2E35]/70">
              {workflowLabel(customerChannel)}
            </span>
          )}
          <span className="inline-flex items-center rounded-full bg-[#F7F4EB] px-2 py-0.5 text-[#1B2E35]/70">
            {task.stage}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {callDateIso && <CallDateBadge callDateIso={callDateIso} />}
          <span className={urgencyClass(task.daysActive)}>
            {task.daysActive === null
              ? '—'
              : task.daysActive === 0
                ? 'today'
                : `${task.daysActive}d`}
          </span>
        </div>
      </div>
    </Link>
  );
}

// Role gate: this page renders the Designer/Senior-Designer kanban. If the
// effective role is something else (e.g. admin switched view-as to an
// Account Creator), bounce back to /workspace which will redirect to the
// right role-appropriate page. Without this, the URL stays at /queue while
// the title shows the new role — misleading layout.
const ALLOWED_ROLES = new Set(['Designer', 'Senior Designer', 'Admin']);

export default async function QueuePage() {
  const session = await requireSession();
  const [ctx, view] = await Promise.all([getEffectiveContext(session), readViewAs()]);

  if (!ALLOWED_ROLES.has(ctx.role)) {
    redirect('/workspace');
  }

  // Admin overview: show ALL active core tasks (no member filter).
  // When admin impersonates a specific member, filter to that member.
  // Non-admin: filter to their own member ID.
  const isAdminBroadView = session.role === 'Admin' && view.kind !== 'member';

  const [tasks, customers, members] = await Promise.all([
    isAdminBroadView
      ? getAllCoreTasks(['Active'])
      : getTasksAssignedTo(ctx.memberId, ['Active']),
    getCustomers(),
    getTeamMembers(),
  ]);

  // For broad view, narrow to designer-pattern tasks for the kanban
  const filteredTasks = isAdminBroadView
    ? tasks.filter((t) => COLUMNS.some((c) => c.match(t.taskName)))
    : tasks;

  // FIFO within each column — oldest activated first. The fetcher returns
  // them in stageOrder/taskOrder, which collapses to insertion order within
  // a kanban column (every "Create Designs" shares the same template position),
  // so the designer's prioritization signal was effectively random before this.
  const sortedTasks = [...filteredTasks].sort(
    (a, b) => Date.parse(a.activatedAt || '') - Date.parse(b.activatedAt || ''),
  );

  const customerMap = new Map<string, Customer>(customers.map((c) => [c.id, c]));
  const memberMap = new Map<string, TeamMember>(members.map((m) => [m.id, m]));
  const { columns, other } = bucketize(sortedTasks);

  function assigneeNames(task: Task): string | undefined {
    if (!isAdminBroadView) return undefined;
    if (task.assignedTo.length === 0) return 'unassigned';
    return task.assignedTo
      .map((id) => memberMap.get(id)?.name?.split(' ')[0] ?? id)
      .join(', ');
  }

  const heading = isAdminBroadView
    ? 'Design Queue'
    : view.kind === 'member'
      ? `${ctx.label}'s Queue`
      : 'My Queue';

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1B2E35]">{heading}</h1>
          <p className="text-sm text-[#1B2E35]/60 mt-1">
            {filteredTasks.length} active task{filteredTasks.length === 1 ? '' : 's'}
            {isAdminBroadView && ' (all designers)'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const items = columns.get(col.key) ?? [];
          return (
            <div key={col.key} className="flex flex-col">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[#1B2E35]">
                  <span className="mr-1.5">{col.emoji}</span>
                  {col.title}
                </h2>
                <span className="text-xs text-[#1B2E35]/50">{items.length}</span>
              </div>
              <div className="space-y-2 min-h-[60px]">
                {items.length === 0 ? (
                  <p className="text-xs text-[#1B2E35]/40 italic px-3 py-4 rounded-lg border border-dashed border-[#E0DEE4]">
                    Nothing here
                  </p>
                ) : (
                  items.map((task) => {
                    const cId = task.customer[0];
                    const customer = cId ? customerMap.get(cId) : undefined;
                    return (
                      <TaskCard
                        key={task.id}
                        task={task}
                        customerName={customer?.name ?? 'Unknown'}
                        customerId={cId ?? ''}
                        customerChannel={customer?.channel}
                        callDateIso={customer?.callDate ?? ''}
                        assignees={assigneeNames(task)}
                      />
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {other.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-[#1B2E35] mb-3">
            Other tasks ({other.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {other.map((task) => {
              const cId = task.customer[0];
              const customer = cId ? customerMap.get(cId) : undefined;
              return (
                <TaskCard
                  key={task.id}
                  task={task}
                  customerName={customer?.name ?? 'Unknown'}
                  customerId={cId ?? ''}
                  customerChannel={customer?.channel}
                  callDateIso={customer?.callDate ?? ''}
                  assignees={assigneeNames(task)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
