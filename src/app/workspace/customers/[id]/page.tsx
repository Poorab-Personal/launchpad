import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession, getEffectiveContext } from '@/lib/auth/dal';
import {
  getCustomerById,
  getTasksForCustomer,
  getTeamMembers,
} from '@/lib/db';
import type { Customer, Task, TeamMember, AirtableAttachment, TaskStatus } from '@/types';
import MarkCompleteButton from './MarkCompleteButton';
import ProofTaskAction from './ProofTaskAction';
import ReviewDesignsAction from './ReviewDesignsAction';
import SendToCustomerAction from './SendToCustomerAction';
import CallsSection from './CallsSection';
import LogCallButton, { type CSMOption } from './LogCallButton';
import CreateAccountAction from './CreateAccountAction';
import SendCredentialsAction from './SendCredentialsAction';
import { tempPasswordFromName } from '@/lib/temp-password';
import CopyableField from './CopyableField';
import { groupDrafts, formatGroupStamp } from './draft-groups';

/**
 * Internal upload tasks — designer adds work-in-progress to Design Drafts.
 * Uses the inline ProofTaskAction (multi-file picker, marks task complete on submit).
 */
function isInternalUploadTask(name: string): boolean {
  return name === 'Create Designs' || /^Revise Design \((Internal )?Round/i.test(name);
}

/**
 * Send-to-customer tasks — Kaushal curates which Drafts to ship + can add new files.
 * Uses the SendToCustomerAction modal. The API replaces Customer.Design Proof.
 */
function isSendToCustomerTask(name: string): boolean {
  return name === 'Upload Proof to Customer' || /^Upload Revised Proof \(Round/i.test(name);
}

function ctaLabelForTask(name: string): string {
  if (isSendToCustomerTask(name)) return 'Send to Customer';
  if (isInternalUploadTask(name)) return 'Upload & Mark Complete';
  return 'Mark Complete';
}

function StatusDot({ status }: { status: TaskStatus }) {
  const map: Record<TaskStatus, string> = {
    Completed: 'bg-[#05C68E]',
    Active: 'bg-[#6C4AB6] ring-2 ring-[#6C4AB6]/30',
    'In Review': 'bg-[#D97706]',
    Draft: 'border-2 border-[#1B2E35]/25 bg-transparent',
    Rejected: 'bg-[#EC531A]',
  };
  return (
    <span
      title={status}
      className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${map[status]}`}
      aria-label={status}
    />
  );
}

function MemberName({
  ids,
  members,
}: {
  ids: string[];
  members: Map<string, TeamMember>;
}) {
  if (ids.length === 0) return <span className="text-[#1B2E35]/40">—</span>;
  return <span>{ids.map((id) => members.get(id)?.name ?? id).join(', ')}</span>;
}

function AssetThumb({ attachment, label }: { attachment?: AirtableAttachment; label: string }) {
  if (!attachment) {
    return (
      <div className="rounded-lg border border-dashed border-[#E0DEE4] p-3 text-center">
        <p className="text-xs text-[#1B2E35]/40">{label}</p>
        <p className="text-xs text-[#1B2E35]/30 italic mt-0.5">Not uploaded</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[#E0DEE4] overflow-hidden bg-white flex flex-col">
      <div className="aspect-square bg-[#F7F4EB] relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.url}
          alt={attachment.filename ?? label}
          className="absolute inset-0 w-full h-full object-contain"
        />
      </div>
      <div className="px-2 py-1.5 flex items-center justify-between gap-1">
        <p className="text-[11px] text-[#1B2E35]/60 truncate flex-1">{label}</p>
        <a
          href={attachment.url}
          download
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-[#6C4AB6] hover:underline shrink-0"
        >
          Download
        </a>
      </div>
    </div>
  );
}

/**
 * Thin labeled divider inside the Intake Form Details card. Tagged with a
 * small uppercase title above the fields it groups. First sub-section omits
 * the top border so the section header doesn't get double-underlined.
 */
function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6 first:mt-0 first:border-t-0 border-t border-[#E0DEE4] pt-5 first:pt-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#1B2E35]/45 mb-3">
        {title}
      </p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">{children}</dl>
    </div>
  );
}

/**
 * "Updated today" / "Updated 3 days ago" / "Updated on May 12" — coarse,
 * one-stamp-per-batch precision. We deliberately don't track per-attachment
 * timestamps (Airtable doesn't expose them); the round-grouped gallery is
 * deferred until customers actually need it.
 */
function relativeUpdatedLabel(iso: string): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 14) return `Updated ${days} days ago`;
  return `Updated on ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function TaskActionPanel({
  task,
  customerId,
  customer,
  isMine,
}: {
  task: Task;
  customerId: string;
  customer: Customer;
  isMine: boolean;
}) {
  if (!isMine || task.status !== 'Active') {
    return null;
  }

  // Account Creator action panels: dedicated UIs for these specific tasks.
  if (task.taskName === 'Create Customer Account') {
    return (
      <CreateAccountAction
        taskId={task.id}
        customerId={customerId}
        initialPlatformEmail={customer.platformEmail}
      />
    );
  }
  if (task.taskName === 'Send Credentials') {
    return (
      <SendCredentialsAction
        taskId={task.id}
        customerId={customerId}
        platformEmail={customer.platformEmail}
        derivedPassword={tempPasswordFromName(customer.name)}
      />
    );
  }

  const showFeedback = /Revis(e|ion)|Round/i.test(task.taskName) && customer.designFeedback;
  const isInternal = isInternalUploadTask(task.taskName);
  const isSendTask = isSendToCustomerTask(task.taskName);
  // For internal tasks (incl. Review Designs) the latest activity is in Drafts.
  // For send tasks and downstream the latest activity is what was sent (Design Proof).
  const previewSet = isSendTask ? customer.designProof : customer.designDrafts;
  const previewLatest = previewSet[previewSet.length - 1];
  const previewLabel = isSendTask
    ? 'Last sent to customer'
    : customer.designDrafts.length > 0
      ? 'Latest draft'
      : '';

  return (
    <div className="space-y-3">
      {showFeedback && (
        <div className="rounded-lg bg-[#D97706]/5 border border-[#D97706]/20 p-3">
          <p className="text-xs uppercase tracking-wide text-[#D97706] font-semibold mb-1">
            Customer feedback
          </p>
          <p className="text-sm text-[#1B2E35] whitespace-pre-wrap">
            {customer.designFeedback}
          </p>
        </div>
      )}
      {task.notes && task.notes !== customer.designFeedback && (
        <div className="rounded-lg bg-[#F7F4EB] p-3">
          <p className="text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1">
            Task notes
          </p>
          <p className="text-sm text-[#1B2E35] whitespace-pre-wrap">{task.notes}</p>
        </div>
      )}
      {(isInternal || isSendTask) && previewLatest && previewLabel && (
        <div className="rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] p-3 space-y-1">
          <p className="text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold">
            {previewLabel}
          </p>
          <a
            href={previewLatest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[#6C4AB6] hover:underline line-clamp-1"
          >
            {previewLatest.filename ?? 'View file'}
          </a>
        </div>
      )}
      {isSendTask ? (
        <SendToCustomerAction
          customerId={customerId}
          taskId={task.id}
          ctaLabel={ctaLabelForTask(task.taskName)}
          drafts={customer.designDrafts}
          currentlySent={customer.designProof}
        />
      ) : isInternal ? (
        // proofRequired=true: server-side already requires >=1 file (see
        // src/app/api/workspace/design-proof/route.ts), but the client used
        // to allow Mark Complete with 0 files via the markTaskComplete
        // shortcut. That let Kaushal "complete" Create Designs / Revise
        // rounds without attaching anything — surfaced 2026-05-22 on Chris
        // Fosgate (3 silent zero-file completions; Jigar caught 2 of 3).
        // Flipping to true disables the button until a file is picked.
        <ProofTaskAction
          customerId={customerId}
          taskId={task.id}
          hasExistingProof={false}
          proofRequired={true}
          ctaLabel={ctaLabelForTask(task.taskName)}
        />
      ) : task.taskName === 'Review Designs' ? (
        <ReviewDesignsAction customerId={customerId} taskId={task.id} />
      ) : (
        <MarkCompleteButton taskId={task.id} customerId={customerId} />
      )}
    </div>
  );
}

function groupByStage(tasks: Task[]): Array<{ stage: string; tasks: Task[] }> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!map.has(t.stage)) map.set(t.stage, []);
    map.get(t.stage)!.push(t);
  }
  return Array.from(map.entries()).map(([stage, tasks]) => ({ stage, tasks }));
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ taskId?: string }>;
}) {
  const session = await requireSession();
  const { id: customerId } = await params;
  const { taskId: highlightTaskId } = await searchParams;

  const [customer, tasks, members, ctx] = await Promise.all([
    getCustomerById(customerId),
    getTasksForCustomer(customerId),
    getTeamMembers(),
    getEffectiveContext(session),
  ]);

  if (!customer) notFound();

  const memberMap = new Map<string, TeamMember>(members.map((m) => [m.id, m]));
  const coreTasks = tasks.filter((t) => t.product === 'Core');
  const stageGroups = groupByStage(coreTasks);

  const highlighted = highlightTaskId
    ? coreTasks.find((t) => t.id === highlightTaskId)
    : undefined;

  // "Mine" = the effective memberId (who we're impersonating, or self).
  // Real Admins (no view-as) can act on any task.
  const isRealAdmin = session.role === 'Admin' && !ctx.isViewAs;
  function isAssignedToEffective(t: Task): boolean {
    return isRealAdmin || t.assignedTo.includes(ctx.memberId);
  }

  const myActiveTasks = coreTasks.filter(
    (t) => t.status === 'Active' && isAssignedToEffective(t),
  );

  // Surface the current active task in the header — first team task if any,
  // otherwise the first active client task. Helps anyone glance at "where
  // are we right now" without scrolling.
  const headerCurrentTask =
    coreTasks.find((t) => t.status === 'Active' && t.taskType === 'Team') ??
    coreTasks.find((t) => t.status === 'Active');
  const headerTaskAssignee = headerCurrentTask?.assignedTo[0]
    ? memberMap.get(headerCurrentTask.assignedTo[0])?.name
    : undefined;

  // CSM/Admin can see + edit calls (notes, recording URL) and log ad-hoc calls.
  // Use the effective role (ctx) so an Admin viewing-as a Designer sees the
  // Designer's UI, not the Admin's.
  const canEditCalls =
    ctx.role === 'Admin' ||
    ctx.role === 'CSM' ||
    ctx.role === 'Senior CSM';
  const csmOptions: CSMOption[] = members
    .filter((m) => (m.role === 'CSM' || m.role === 'Senior CSM') && m.active)
    .map((m) => ({ id: m.id, name: m.name }));

  return (
    <div className="space-y-6">
      <Link
        href="/workspace/queue"
        className="inline-flex items-center gap-1 text-sm text-[#6C4AB6] hover:underline"
      >
        ← Back to queue
      </Link>

      {/* Header */}
      <div className="rounded-xl bg-white border border-[#E0DEE4] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-[#1B2E35]">{customer.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-sm text-[#1B2E35]/60">
                {customer.businessName || 'No business name'}
              </p>
              <span className="inline-flex items-center rounded-full bg-[#F7F4EB] px-2 py-0.5 text-[11px] font-medium text-[#1B2E35]/70">
                {customer.type}
                {customer.channel && ` · ${customer.channel}`}
              </span>
            </div>
          </div>
          <div className="text-right space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-[#1B2E35]/50 font-medium">
                Current Stage
              </p>
              <p className="text-sm font-semibold text-[#6C4AB6] mt-1">
                {customer.currentStage || '—'}
              </p>
            </div>
            {headerCurrentTask && (
              <div>
                <p className="text-xs uppercase tracking-wide text-[#1B2E35]/50 font-medium">
                  Current Task
                </p>
                <p className="text-sm text-[#1B2E35] mt-1">
                  {headerCurrentTask.taskName}
                </p>
                {headerTaskAssignee && (
                  <p className="text-xs text-[#1B2E35]/60 mt-0.5">
                    → {headerTaskAssignee}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-[#E0DEE4] flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <div>
            <span className="text-[#1B2E35]/50">CSM: </span>
            <MemberName ids={customer.csmAssigned} members={memberMap} />
          </div>
          <div>
            <span className="text-[#1B2E35]/50">Design Approval: </span>
            <span className="text-[#1B2E35]">{customer.designApproval ?? 'Pending'}</span>
          </div>
          <div>
            <span className="text-[#1B2E35]/50">Revisions: </span>
            <span className="text-[#1B2E35]">{customer.designRevisionCount}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Customer workspace (2/3 width) */}
        <div className="lg:col-span-2 space-y-6">
          <section className="rounded-xl bg-white border border-[#E0DEE4] p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">
                Customer Inputs
              </h2>
              <p className="text-xs text-[#1B2E35]/50 mt-0.5">
                Files and assets uploaded by the customer.
              </p>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-md">
              {customer.agentPhoto.length === 0 ? (
                <AssetThumb label="Agent Photo" />
              ) : (
                customer.agentPhoto.map((a, i) => (
                  <AssetThumb
                    key={`photo-${i}`}
                    attachment={a}
                    label={
                      customer.agentPhoto.length === 1
                        ? 'Agent Photo'
                        : `Photo ${i + 1}`
                    }
                  />
                ))
              )}
              {customer.businessLogo.length === 0 ? (
                <AssetThumb label="Business Logo" />
              ) : (
                customer.businessLogo.map((a, i) => (
                  <AssetThumb
                    key={`logo-${i}`}
                    attachment={a}
                    label={
                      customer.businessLogo.length === 1
                        ? 'Business Logo'
                        : `Logo ${i + 1}`
                    }
                  />
                ))
              )}
            </div>
            {customer.otherAssets.length > 0 && (
              <div className="mt-4 pt-4 border-t border-[#E0DEE4]">
                <p className="text-xs uppercase tracking-wide text-[#1B2E35]/50 font-medium mb-2">
                  Other Assets ({customer.otherAssets.length})
                </p>
                <ul className="space-y-1">
                  {customer.otherAssets.map((a, i) => (
                    <li key={i}>
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-[#6C4AB6] hover:underline"
                      >
                        {a.filename ?? `File ${i + 1}`}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="rounded-xl bg-white border border-[#E0DEE4] p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">
                Design Drafts
              </h2>
              <p className="text-xs text-[#1B2E35]/50 mt-0.5">
                Internal work-in-progress from the design team. Customer does not see these.
              </p>
            </div>
            {customer.designDrafts.length === 0 ? (
              <p className="text-sm text-[#1B2E35]/40 italic">
                No drafts uploaded yet.
              </p>
            ) : (
              <div className="space-y-6">
                {groupDrafts(customer.designDrafts).map((g, gi) => {
                  const stamp = formatGroupStamp(g.newestAt);
                  return (
                    <div key={`g-${gi}`}>
                      <div className="mb-2 flex items-center gap-2 text-xs">
                        <span className="font-semibold text-[#1B2E35]">
                          {g.label}
                        </span>
                        <span className="text-[#1B2E35]/40">
                          · {g.drafts.length} file{g.drafts.length === 1 ? '' : 's'}
                        </span>
                        {stamp && (
                          <span className="text-[#1B2E35]/40">· {stamp}</span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-md">
                        {g.drafts.map((a, i) => (
                          <AssetThumb
                            key={`g-${gi}-${i}`}
                            attachment={a}
                            label={a.filename ?? `File ${i + 1}`}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-xl bg-white border border-[#E0DEE4] p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70">
                  Sent to Customer
                </h2>
                <p className="text-xs text-[#1B2E35]/50 mt-0.5">
                  The curated set the customer is currently reviewing in their portal.
                </p>
              </div>
              {customer.designProofsUpdatedAt && customer.designProof.length > 0 && (
                <span className="shrink-0 rounded-full bg-[#F7F4EB] px-2.5 py-0.5 text-[11px] font-medium text-[#1B2E35]/60">
                  {relativeUpdatedLabel(customer.designProofsUpdatedAt)}
                </span>
              )}
            </div>
            {customer.designProof.length === 0 ? (
              <p className="text-sm text-[#1B2E35]/40 italic">
                Nothing sent to the customer yet.
              </p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-md">
                {customer.designProof.map((a, i) => (
                  <AssetThumb
                    key={`sent-${i}`}
                    attachment={a}
                    label={a.filename ?? `File ${i + 1}`}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl bg-white border border-[#E0DEE4] p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70 mb-5">
              Intake Form Details
            </h2>

            <SubSection title="Business & Contact">
              <CopyableField label="Business Name" value={customer.businessName} />
              <CopyableField label="Website" value={customer.website} />
              <CopyableField label="Phone" value={customer.phone} />
              <CopyableField label="Business Address" value={customer.businessAddress} />
              <CopyableField label="Signin Email" value={customer.contactEmail} />
              <CopyableField label="Platform Email" value={customer.platformEmail} />
              <CopyableField label="Other Emails" value={customer.otherEmails} />
              <CopyableField label="License Number" value={customer.licenseNumber} />
              <CopyableField label="GMB Name" value={customer.gmbName} />
              <CopyableField label="MLS IDs" value={customer.mlsIds} />
            </SubSection>

            <SubSection title="Bio">
              <CopyableField label="Bio" value={customer.bio} expandable className="sm:col-span-2" />
            </SubSection>

            <SubSection title="Content Direction">
              <CopyableField label="Service Areas" value={customer.serviceAreas} />
              <CopyableField label="Local Content Areas" value={customer.localContentAreas} />
              <CopyableField label="Topics" value={customer.topics} />
              <CopyableField label="Hashtags" value={customer.hashtags} />
            </SubSection>

            {customer.specialInstructions && (
              <SubSection title="Special Instructions">
                <CopyableField
                  label="Special Instructions"
                  value={customer.specialInstructions}
                  className="sm:col-span-2"
                />
              </SubSection>
            )}
          </section>

          {canEditCalls && (
            <CallsSection customerId={customerId} canEdit={canEditCalls} />
          )}
        </div>

        {/* Right rail: Action panel + Tasks */}
        <aside className="space-y-6">
          {canEditCalls && (
            <section className="rounded-xl bg-white border border-[#E0DEE4] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70 mb-3">
                Log a call
              </h2>
              <LogCallButton
                customerId={customerId}
                currentMemberId={ctx.memberId}
                csms={csmOptions}
              />
            </section>
          )}
          {highlighted ? (
            <section className="rounded-xl bg-white border-2 border-[#6C4AB6] p-5">
              <div className="mb-4">
                <p className="text-xs uppercase tracking-wide text-[#6C4AB6] font-semibold">
                  Current Task
                </p>
                <h2 className="text-base font-semibold text-[#1B2E35] mt-1">
                  {highlighted.taskName}
                </h2>
                <div className="mt-2 flex items-center gap-2">
                  <StatusDot status={highlighted.status} />
                  <span className="text-xs text-[#1B2E35]/70">{highlighted.status}</span>
                </div>
              </div>
              {highlighted.instructions && (
                <p className="text-sm text-[#1B2E35]/70 mb-4">{highlighted.instructions}</p>
              )}
              <TaskActionPanel
                task={highlighted}
                customerId={customerId}
                customer={customer}
                isMine={isAssignedToEffective(highlighted)}
              />
              {!isAssignedToEffective(highlighted) && (
                <p className="text-xs text-[#1B2E35]/50 mt-3 text-center">
                  Not assigned to {ctx.isViewAs ? ctx.label : 'you'}. Read-only.
                </p>
              )}
            </section>
          ) : myActiveTasks.length > 0 ? (
            <section className="rounded-xl bg-white border border-[#E0DEE4] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1B2E35]/70 mb-3">
                Your Active Tasks
              </h2>
              <ul className="space-y-3">
                {myActiveTasks.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-lg border border-[#E0DEE4] p-3 space-y-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-[#1B2E35]">{t.taskName}</p>
                      <p className="text-xs text-[#1B2E35]/60 mt-0.5">{t.stage}</p>
                    </div>
                    <TaskActionPanel
                      task={t}
                      customerId={customerId}
                      customer={customer}
                      isMine={true}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section className="rounded-xl bg-white border border-[#E0DEE4] p-5 text-center">
              <p className="text-sm text-[#1B2E35]/60">
                No active tasks for you on this customer.
              </p>
            </section>
          )}

          {/* Tasks grouped by stage */}
          <section className="rounded-xl bg-white border border-[#E0DEE4] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#1B2E35]/70 mb-3 px-1">
              Tasks ({coreTasks.length})
            </h3>
            <div className="space-y-1">
              {stageGroups.map(({ stage, tasks: stageTasks }) => {
                const completed = stageTasks.filter((t) => t.status === 'Completed').length;
                const total = stageTasks.length;
                const isCurrent = stage === customer.currentStage;
                const hasActive = stageTasks.some((t) => t.status === 'Active');
                const defaultOpen = isCurrent || hasActive;
                return (
                  <details
                    key={stage}
                    open={defaultOpen}
                    className="group rounded-md"
                  >
                    <summary
                      className={`cursor-pointer list-none px-2 py-1.5 rounded-md text-sm flex items-center justify-between gap-2 hover:bg-[#F7F4EB] ${
                        isCurrent ? 'bg-[#6C4AB6]/5 text-[#6C4AB6] font-medium' : 'text-[#1B2E35]'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="text-[10px] text-[#1B2E35]/40 group-open:rotate-90 transition-transform inline-block">
                          ▶
                        </span>
                        {stage}
                      </span>
                      <span className="text-xs text-[#1B2E35]/50">
                        {completed}/{total}
                      </span>
                    </summary>
                    <ul className="pl-4 py-1 space-y-0.5">
                      {stageTasks.map((t) => {
                        const linkProps =
                          t.status === 'Active'
                            ? {
                                href: `/workspace/customers/${customerId}?taskId=${t.id}`,
                                className: `flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-[#F7F4EB] ${
                                  t.id === highlightTaskId
                                    ? 'bg-[#6C4AB6]/10 text-[#6C4AB6]'
                                    : 'text-[#1B2E35]/80'
                                }`,
                              }
                            : null;
                        const content = (
                          <>
                            <StatusDot status={t.status} />
                            <span
                              className={`flex-1 line-clamp-1 ${t.status === 'Completed' ? 'line-through text-[#1B2E35]/40' : ''}`}
                            >
                              {t.taskName}
                            </span>
                          </>
                        );
                        return (
                          <li key={t.id}>
                            {linkProps ? (
                              <Link href={linkProps.href} className={linkProps.className}>
                                {content}
                              </Link>
                            ) : (
                              <div
                                className={`flex items-center gap-2 px-2 py-1 rounded text-xs ${
                                  t.id === highlightTaskId
                                    ? 'bg-[#6C4AB6]/10 text-[#6C4AB6]'
                                    : 'text-[#1B2E35]/60'
                                }`}
                              >
                                {content}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                );
              })}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
