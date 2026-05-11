import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCustomerById, getTasksForCustomer, getTeamMembers, getBrokerageById } from '@/lib/db';
import type { TaskStatus } from '@/types';

const statusColor: Record<TaskStatus, string> = {
  Draft: 'bg-[#E0DEE4]/50 text-[#1B2E35]/60',
  Active: 'bg-[#6C4AB6]/10 text-[#6C4AB6]',
  'In Review': 'bg-[#DABA21]/10 text-[#DABA21]',
  Completed: 'bg-[#05C68E]/10 text-[#05C68E]',
  Rejected: 'bg-[#EC531A]/10 text-[#EC531A]',
};

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const customer = await getCustomerById(customerId);

  if (!customer) {
    notFound();
  }

  const tasks = await getTasksForCustomer(customer.id);
  const teamMembers = await getTeamMembers();
  const memberNameMap = new Map(teamMembers.map((m) => [m.id, m.name]));
  const brokerageName = customer.type === 'B2B' && customer.brokerage.length > 0
    ? (await getBrokerageById(customer.brokerage[0]))?.name ?? ''
    : '';

  // Group tasks by product, then core tasks by stage
  const coreTasks = tasks.filter((t) => t.product === 'Core' || !t.product);
  const voiceTasks = tasks.filter((t) => t.product === 'Voice');
  const avatarTasks = tasks.filter((t) => t.product === 'Avatar');

  const coreStageMap = new Map<string, { order: number; tasks: typeof tasks }>();
  for (const task of coreTasks) {
    const existing = coreStageMap.get(task.stage);
    if (existing) {
      existing.tasks.push(task);
      if (task.stageOrder > existing.order) existing.order = task.stageOrder;
    } else {
      coreStageMap.set(task.stage, { order: task.stageOrder, tasks: [task] });
    }
  }
  const coreStages = [...coreStageMap.entries()]
    .sort((a, b) => a[1].order - b[1].order);
  const allCoreStageNames = coreStages.map(([name]) => name);
  const currentStageIdx = allCoreStageNames.indexOf(customer.currentStage);

  // Group addon tasks by stage within each product
  function groupByStage(addonTasks: typeof tasks) {
    const map = new Map<string, { order: number; tasks: typeof tasks }>();
    for (const task of addonTasks) {
      const existing = map.get(task.stage);
      if (existing) {
        existing.tasks.push(task);
        if (task.stageOrder > existing.order) existing.order = task.stageOrder;
      } else {
        map.set(task.stage, { order: task.stageOrder, tasks: [task] });
      }
    }
    return [...map.entries()].sort((a, b) => a[1].order - b[1].order);
  }

  return (
    <div>
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-[#6C4AB6] hover:text-[#6C4AB6]/80 transition-colors">
        &larr; Back to customers
      </Link>

      {/* Customer header */}
      <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white p-6 shadow-[0px_4px_12px_#1B2E3514]">
        <h1 className="mb-1 font-[var(--font-outfit)] text-2xl font-bold text-[#1B2E35]">{customer.name}</h1>
        {customer.businessName && (
          <p className="text-sm text-[#1B2E35]/60">{customer.businessName}</p>
        )}
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Type" value={customer.type} />
        <Field label="Channel" value={customer.channel} />
        <Field label="Contact Email" value={customer.contactEmail} />
        <Field label="Platform Email" value={customer.platformEmail} />
        <Field label="Phone" value={customer.phone} />
      </Section>

      {/* Business Info */}
      {(customer.businessName || customer.website || customer.bio) && (
        <Section title="Business Info">
          <Field label="Business Name" value={customer.businessName} />
          <Field label="Website" value={customer.website} />
          <Field label="Business Address" value={customer.businessAddress} />
          <Field label="Service Areas" value={customer.serviceAreas} />
          <Field label="Bio" value={customer.bio} />
          <Field label="License Number" value={customer.licenseNumber} />
        </Section>
      )}

      {/* Assets */}
      {(customer.agentPhoto.length > 0 || customer.businessLogo.length > 0 || customer.otherAssets.length > 0) && (
        <Section title="Assets">
          <Field label="Agent Photo" value={customer.agentPhoto.length > 0 ? `${customer.agentPhoto.length} file(s)` : ''} />
          <Field label="Business Logo" value={customer.businessLogo.length > 0 ? `${customer.businessLogo.length} file(s)` : ''} />
          <Field label="Other Assets" value={customer.otherAssets.length > 0 ? `${customer.otherAssets.length} file(s)` : ''} />
        </Section>
      )}

      {/* Payment (D2C only) */}
      {customer.type === 'D2C' && (
        <Section title="Payment">
          <Field label="Product Tier" value={customer.productTier ?? ''} />
          <Field label="Payment Status" value={customer.paymentStatus ?? ''} />
          <Field label="HubSpot Deal ID" value={customer.hubspotDealId} />
          <Field label="Stripe Payment ID" value={customer.stripePaymentId} />
        </Section>
      )}

      {/* Design (D2C only) */}
      {customer.type === 'D2C' && customer.designApproval && (
        <Section title="Design">
          <Field label="Design Approval" value={customer.designApproval} />
          <Field label="Design Feedback" value={customer.designFeedback} />
        </Section>
      )}

      {/* Enterprise (B2B only) */}
      {customer.type === 'B2B' && (
        <Section title="Enterprise">
          <Field label="Brokerage" value={brokerageName} />
        </Section>
      )}

      {/* Status */}
      <Section title="Status">
        <Field label="Current Stage" value={customer.currentStage} />
        <Field label="Stage Entered At" value={customer.stageEnteredAt ? new Date(customer.stageEnteredAt).toLocaleDateString() : ''} />
        <Field label="Account Created" value={customer.accountCreated ? 'Yes' : 'No'} />
        <Field label="Credentials Sent" value={customer.credentialsSent ? 'Yes' : 'No'} />
        <Field label="Call Booked" value={customer.callBooked ? 'Yes' : 'No'} />
        <Field label="Call Completed" value={customer.callCompleted ? 'Yes' : 'No'} />
        <Field label="CSM Assigned" value={customer.csmAssigned.length > 0 ? memberNameMap.get(customer.csmAssigned[0]) ?? customer.csmAssigned[0] : ''} />
      </Section>

      {/* Tasks grouped by stage */}
      <h2 className="mt-8 mb-4 font-[var(--font-outfit)] text-lg font-semibold text-[#1B2E35]">
        Tasks ({tasks.length})
      </h2>

      <div className="mb-8 space-y-4">
        {coreStages.map(([stageName, { tasks: stageTasks }], idx) => {
          const sorted = [...stageTasks].sort((a, b) => a.taskOrder - b.taskOrder);
          const completed = sorted.filter((t) => t.status === 'Completed').length;
          const active = sorted.filter((t) => t.status === 'Active' || t.status === 'In Review').length;
          const stageStatus = idx < currentStageIdx ? 'completed' : idx === currentStageIdx ? 'active' : 'upcoming';

          return (
            <div key={stageName} className="rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514] overflow-hidden">
              {/* Stage header */}
              <div className={`flex items-center justify-between px-5 py-3 border-b border-[#E0DEE4] ${
                stageStatus === 'active' ? 'bg-[#6C4AB6]/5' : stageStatus === 'completed' ? 'bg-[#05C68E]/5' : 'bg-[#F7F4EB]'
              }`}>
                <div className="flex items-center gap-2.5">
                  {stageStatus === 'completed' ? (
                    <svg className="h-4 w-4 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  ) : (
                    <span className={`inline-flex h-2.5 w-2.5 rounded-full ${
                      stageStatus === 'active' ? 'bg-[#6C4AB6]' : 'bg-[#E0DEE4]'
                    }`} />
                  )}
                  <h3 className="font-[var(--font-outfit)] text-sm font-semibold text-[#1B2E35]">{stageName}</h3>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    stageStatus === 'completed'
                      ? 'bg-[#05C68E]/10 text-[#05C68E]'
                      : stageStatus === 'active'
                        ? 'bg-[#6C4AB6]/10 text-[#6C4AB6]'
                        : 'bg-[#E0DEE4]/70 text-[#1B2E35]/40'
                  }`}>
                    {stageStatus === 'completed' ? 'Completed' : stageStatus === 'active' ? 'In Progress' : 'Upcoming'}
                  </span>
                </div>
                <span className="text-xs font-medium text-[#1B2E35]/40">
                  {completed}/{sorted.length} done
                </span>
              </div>

              {/* Task rows */}
              <div className="divide-y divide-[#E0DEE4]/60">
                {sorted.map((task) => (
                  <div key={task.id} className={`flex items-center gap-3 px-5 py-2.5 ${
                    task.status === 'Completed' ? 'bg-[#05C68E]/[0.03]' : ''
                  }`}>
                    {/* Status icon */}
                    {task.status === 'Completed' ? (
                      <svg className="h-4 w-4 shrink-0 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                    ) : task.status === 'Active' || task.status === 'In Review' ? (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="h-2 w-2 rounded-full bg-[#6C4AB6]" />
                      </span>
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="h-2 w-2 rounded-full border-[1.5px] border-[#E0DEE4]" />
                      </span>
                    )}

                    {/* Task name */}
                    <span className={`flex-1 min-w-0 text-sm truncate ${
                      task.status === 'Completed' ? 'text-[#1B2E35]/50' : 'text-[#1B2E35] font-medium'
                    }`}>
                      {task.taskName}
                      {task.hasTeamReview && (
                        <span className="ml-1.5 inline-flex rounded-full bg-[#DABA21]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#DABA21]">Review</span>
                      )}
                    </span>

                    {/* Type */}
                    <span className={`shrink-0 text-xs font-medium ${
                      task.taskType === 'Team' ? 'text-[#6C4AB6]' : 'text-[#05C68E]'
                    }`}>{task.taskType}</span>

                    {/* Status pill */}
                    <span className={`shrink-0 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[task.status]}`}>
                      {task.status}
                    </span>

                    {/* Assigned */}
                    <span className="shrink-0 w-24 text-xs text-[#1B2E35]/40 truncate text-right">
                      {task.assignedTo.length > 0 ? memberNameMap.get(task.assignedTo[0]) ?? '—' : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* Add-on product groups */}
        {[
          { label: 'Voice Add-On', tasks: voiceTasks },
          { label: 'Avatar Add-On', tasks: avatarTasks },
        ]
          .filter(({ tasks: t }) => t.length > 0)
          .map(({ label, tasks: addonTasks }) => {
            const stages = groupByStage(addonTasks);
            const totalCompleted = addonTasks.filter((t) => t.status === 'Completed').length;

            return (
              <div key={label} className="rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514] overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#E0DEE4] bg-[#6C4AB6]/5">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#6C4AB6]" />
                    <h3 className="font-[var(--font-outfit)] text-sm font-semibold text-[#1B2E35]">{label}</h3>
                    <span className="inline-flex rounded-full bg-[#6C4AB6]/10 px-2 py-0.5 text-[10px] font-medium text-[#6C4AB6]">
                      Add-On
                    </span>
                  </div>
                  <span className="text-xs font-medium text-[#1B2E35]/40">
                    {totalCompleted}/{addonTasks.length} done
                  </span>
                </div>

                {stages.map(([stageName, { tasks: stageTasks }]) => {
                  const sorted = [...stageTasks].sort((a, b) => a.taskOrder - b.taskOrder);
                  return (
                    <div key={stageName}>
                      <div className="px-5 py-1.5 bg-[#F7F4EB]/60 border-b border-[#E0DEE4]/60">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-[#1B2E35]/40">{stageName}</span>
                      </div>
                      <div className="divide-y divide-[#E0DEE4]/60">
                        {sorted.map((task) => (
                          <div key={task.id} className={`flex items-center gap-3 px-5 py-2.5 ${
                            task.status === 'Completed' ? 'bg-[#05C68E]/[0.03]' : ''
                          }`}>
                            {task.status === 'Completed' ? (
                              <svg className="h-4 w-4 shrink-0 text-[#05C68E]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                              </svg>
                            ) : task.status === 'Active' || task.status === 'In Review' ? (
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <span className="h-2 w-2 rounded-full bg-[#6C4AB6]" />
                              </span>
                            ) : (
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <span className="h-2 w-2 rounded-full border-[1.5px] border-[#E0DEE4]" />
                              </span>
                            )}
                            <span className={`flex-1 min-w-0 text-sm truncate ${
                              task.status === 'Completed' ? 'text-[#1B2E35]/50' : 'text-[#1B2E35] font-medium'
                            }`}>{task.taskName}</span>
                            <span className={`shrink-0 text-xs font-medium ${
                              task.taskType === 'Team' ? 'text-[#6C4AB6]' : 'text-[#05C68E]'
                            }`}>{task.taskType}</span>
                            <span className={`shrink-0 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[task.status]}`}>
                              {task.status}
                            </span>
                            <span className="shrink-0 w-24 text-xs text-[#1B2E35]/40 truncate text-right">
                              {task.assignedTo.length > 0 ? memberNameMap.get(task.assignedTo[0]) ?? '—' : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-[#E0DEE4] bg-white p-5 shadow-[0px_4px_12px_#1B2E3514]">
      <h2 className="mb-3 font-[var(--font-outfit)] text-sm font-semibold uppercase tracking-wider text-[#1B2E35]/54">{title}</h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
        {children}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium uppercase text-[#1B2E35]/40">{label}</dt>
      <dd className="text-sm text-[#1B2E35]">{value}</dd>
    </div>
  );
}
