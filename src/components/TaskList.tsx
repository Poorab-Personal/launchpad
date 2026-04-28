'use client';

import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Task, Customer } from '@/types';
import TaskRenderer from './tasks/TaskRenderer';

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  );
}

export default function TaskList({
  initialTasks,
  customerId,
  currentStage,
  customer,
}: {
  initialTasks: Task[];
  customerId: string;
  currentStage: string;
  customer: Customer;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  // Partition tasks by product
  const coreTasks = tasks.filter((t) => t.product === 'Core' || !t.product);
  const voiceTasks = tasks.filter((t) => t.product === 'Voice');
  const avatarTasks = tasks.filter((t) => t.product === 'Avatar');
  const showVoice = customer.hasVoice || voiceTasks.length > 0;
  const showAvatar = customer.hasAvatar || avatarTasks.length > 0;
  const hasAddOns = showVoice || showAvatar;

  // Core client-visible tasks for main section
  const coreVisibleTasks = coreTasks.filter((t) => t.visibleToClient);

  // ALL unique stages sorted by stageOrder (for progress bar)
  // Build stage order map — use the highest non-zero stageOrder for each stage
  // (revision tasks have stageOrder=0, so we skip those to avoid misordering)
  const stageMap = new Map<string, number>();
  for (const t of coreTasks) {
    const existing = stageMap.get(t.stage) ?? 0;
    if (t.stageOrder > existing) stageMap.set(t.stage, t.stageOrder);
  }
  const allStages = [...stageMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([stage]) => stage);

  // Only stages with client-visible tasks appear in the progress bar
  const progressStages = allStages.filter((stage) =>
    coreVisibleTasks.some((t) => t.stage === stage),
  );

  function getStageStatus(stage: string) {
    const currentIdx = allStages.indexOf(currentStage);
    const stageIdx = allStages.indexOf(stage);
    if (stageIdx < currentIdx) return 'completed';
    if (stageIdx === currentIdx) return 'active';
    return 'upcoming';
  }

  // Current stage tasks only
  const currentStageTasks = coreVisibleTasks
    .filter((t) => t.stage === currentStage)
    .sort((a, b) => a.taskOrder - b.taskOrder);

  // Does the current stage have any active or draft tasks for the customer?
  const hasActiveTasks = currentStageTasks.some(
    (t) => t.status === 'Active' || t.status === 'Draft',
  );

  function handleTaskComplete(taskId: string) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, status: 'Completed' as const, completedAt: new Date().toISOString() }
          : t,
      ),
    );
    setIsRefreshing(true);
    setTimeout(() => {
      router.refresh();
      setIsRefreshing(false);
    }, 3000);
  }

  function renderAddonCard(
    id: string,
    title: string,
    description: string,
    icon: React.ReactNode,
    addonTasks: Task[],
    addonStage: string,
  ) {
    const visibleAddon = addonTasks.filter((t) => t.visibleToClient);
    const completedCount = visibleAddon.filter((t) => t.status === 'Completed').length;
    const totalCount = visibleAddon.length;
    const allDone = completedCount === totalCount && totalCount > 0;

    // Build stage map for this add-on
    const addonStageMap = new Map<string, number>();
    for (const t of addonTasks) {
      const existing = addonStageMap.get(t.stage) ?? 0;
      if (t.stageOrder > existing) addonStageMap.set(t.stage, t.stageOrder);
    }
    const addonStages = [...addonStageMap.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([stage]) => stage);

    // Determine current stage — use customer field, fallback to first incomplete stage
    let currentAddon = addonStage;
    if (!currentAddon && addonStages.length > 0) {
      currentAddon =
        addonStages.find((stage) =>
          addonTasks.some((t) => t.stage === stage && t.status !== 'Completed'),
        ) || addonStages[0];
    }
    const currentAddonIdx = addonStages.indexOf(currentAddon);

    // Current stage tasks
    const stageTasks = visibleAddon
      .filter((t) => t.stage === currentAddon)
      .sort((a, b) => a.taskOrder - b.taskOrder);

    return (
      <div id={id} className="rounded-lg border border-[#E0DEE4] bg-white p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6C4AB6]/10">
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[#1B2E35]">{title}</h3>
              <span
                className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-medium ${
                  allDone
                    ? 'bg-[#05C68E]/10 text-[#05C68E]'
                    : 'bg-[#DABA21]/10 text-[#DABA21]'
                }`}
              >
                {allDone ? 'Complete' : 'Pending'}
              </span>
            </div>
            <p className="mt-1 text-xs text-[#1B2E35]/60">{description}</p>

            {/* Mini progress */}
            {addonStages.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1">
                {addonStages.map((stage, i) => {
                  const stageIdx = addonStages.indexOf(stage);
                  let status: 'completed' | 'active' | 'upcoming';
                  if (stageIdx < currentAddonIdx) status = 'completed';
                  else if (stageIdx === currentAddonIdx) status = 'active';
                  else status = 'upcoming';

                  return (
                    <Fragment key={stage}>
                      {i > 0 && <span className="text-[#E0DEE4] text-[10px]">&mdash;</span>}
                      <span
                        className={`text-[10px] font-medium ${
                          status === 'completed'
                            ? 'text-[#05C68E]'
                            : status === 'active'
                              ? 'text-[#6C4AB6]'
                              : 'text-[#1B2E35]/30'
                        }`}
                      >
                        {status === 'completed' ? '\u25CF' : '\u25CB'} {stage}
                      </span>
                    </Fragment>
                  );
                })}
              </div>
            )}

            {/* Current stage tasks */}
            {stageTasks.length > 0 && (
              <div className="mt-4 space-y-2">
                {stageTasks.map((task) => {
                  if (task.status === 'Completed') {
                    return (
                      <div
                        key={task.id}
                        className="flex items-center gap-3 rounded-lg border border-[#E0DEE4] bg-[#05C68E]/5 px-4 py-2.5"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#05C68E]/15">
                          <CheckIcon className="h-3 w-3 text-[#05C68E]" />
                        </span>
                        <span className="text-xs text-[#1B2E35]/60 line-through">
                          {task.taskName}
                        </span>
                      </div>
                    );
                  }

                  if (task.status === 'Active') {
                    return (
                      <div
                        key={task.id}
                        className="rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] p-4"
                      >
                        <h4 className="mb-2 text-sm font-semibold text-[#1B2E35]">
                          {task.taskName}
                        </h4>
                        <TaskRenderer
                          task={task}
                          customerId={customerId}
                          customer={customer}
                          onComplete={() => handleTaskComplete(task.id)}
                        />
                      </div>
                    );
                  }

                  // Draft = locked
                  return (
                    <div key={task.id} className="rounded-lg border border-[#E0DEE4] px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#E0DEE4]/50">
                          <LockIcon className="h-3 w-3 text-[#1B2E35]/40" />
                        </span>
                        <span className="text-xs text-[#1B2E35]/54">{task.taskName}</span>
                      </div>
                      {task.dependsOn && task.instructions && (
                        <p className="mt-1.5 ml-8 text-[10px] text-[#1B2E35]/40">
                          {task.instructions}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Progress counter */}
            <p className="mt-3 text-[10px] text-[#1B2E35]/40">
              {totalCount > 0
                ? `${completedCount} of ${totalCount} complete`
                : 'Setup not started'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Refreshing indicator */}
      {isRefreshing && (
        <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm text-[#1B2E35]/60 shadow-[0px_4px_12px_#1B2E3514]">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#6C4AB6]/30 border-t-[#6C4AB6]" />
          Updating…
        </div>
      )}

      {/* Progress bar — ALL stages with client-visible tasks, always shown */}
      <div>
      <nav>
        <ol className="flex flex-wrap items-center gap-2">
          {progressStages.map((stage, i) => {
            const status = getStageStatus(stage);
            const prevStatus = i > 0 ? getStageStatus(progressStages[i - 1]) : null;
            return (
              <li key={stage} className="flex items-center gap-2">
                {i > 0 && (
                  <div
                    className={`h-px w-4 sm:w-6 shrink-0 ${
                      prevStatus === 'completed' && status !== 'upcoming'
                        ? 'bg-[#05C68E]'
                        : 'bg-[#E0DEE4]'
                    }`}
                  />
                )}
                <div
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] sm:text-xs font-medium transition-colors ${
                    status === 'completed'
                      ? 'bg-[#05C68E] text-white'
                      : status === 'active'
                        ? 'bg-[#6C4AB6] text-white'
                        : 'bg-white text-[#1B2E35]/54 border border-[#E0DEE4]'
                  }`}
                >
                  {status === 'completed' && <CheckIcon className="h-3.5 w-3.5" />}
                  {stage}
                </div>
              </li>
            );
          })}
        </ol>
      </nav>

      </div>

      {/* Current stage content ONLY */}
      <div>
        <h2 className="mb-4 text-lg font-semibold text-[#1B2E35]">{currentStage}</h2>

        {/* If no visible tasks in current stage (e.g., Onboarding Call — team only) */}
        {currentStageTasks.length === 0 && (
          <div className="rounded-lg border-l-4 border-l-[#6C4AB6] bg-white px-5 py-4 text-sm text-[#1B2E35]">
            {customer.callDate
              ? `Your onboarding call is scheduled for ${new Date(customer.callDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`
              : "Our team is working on the next step. We'll notify you when something needs your attention."}
          </div>
        )}

        {/* If all visible tasks are completed and team is working (waiting state) */}
        {currentStageTasks.length > 0 && !hasActiveTasks && (
          <div className="rounded-lg border-l-4 border-l-[#DABA21] bg-[#F7F4EB] px-5 py-4 text-sm text-[#1B2E35]/74 mb-4">
            Our team is working on the next step. We&apos;ll email you when something needs your attention.
          </div>
        )}

        <div className="space-y-3">
          {currentStageTasks.map((task) => {
            if (task.status === 'Completed') {
              return (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-lg border border-[#E0DEE4] bg-[#05C68E]/5 px-5 py-3.5"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#05C68E]/15">
                    <CheckIcon className="h-3.5 w-3.5 text-[#05C68E]" />
                  </span>
                  <span className="text-sm text-[#1B2E35]/60 line-through">
                    {task.taskName}
                  </span>
                </div>
              );
            }

            if (task.status === 'Active') {
              return (
                <div
                  key={task.id}
                  className="rounded-lg border border-[#E0DEE4] bg-white p-5 shadow-[0px_4px_12px_#1B2E3514]"
                >
                  <h3 className="mb-3 text-base font-semibold text-[#1B2E35]">
                    {task.taskName}
                  </h3>
                  <TaskRenderer
                    task={task}
                    customerId={customerId}
                    customer={customer}
                    onComplete={() => handleTaskComplete(task.id)}
                  />
                </div>
              );
            }

            // Draft = locked
            return (
              <div
                key={task.id}
                className="rounded-lg border border-[#E0DEE4] bg-white px-5 py-3.5"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#E0DEE4]/50">
                    <LockIcon className="h-3.5 w-3.5 text-[#1B2E35]/40" />
                  </span>
                  <span className="text-sm text-[#1B2E35]/54">{task.taskName}</span>
                </div>
                {task.dependsOn && task.instructions && (
                  <p className="mt-2 ml-9 text-xs text-[#1B2E35]/40">{task.instructions}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Add-Ons Section ──────────────────────────────────────────── */}
      {hasAddOns && (
        <div className="border-t border-[#E0DEE4] pt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[#1B2E35]">Your Add-Ons</h2>
            <span className="text-xs font-medium text-[#1B2E35]/40">
              {[...voiceTasks, ...avatarTasks].filter((t) => t.visibleToClient && t.status === 'Completed').length}{' '}
              of {[...voiceTasks, ...avatarTasks].filter((t) => t.visibleToClient).length} complete
            </span>
          </div>

          <div className="space-y-4">
            {showVoice &&
              renderAddonCard(
                'voice-addon',
                'AI Voice Setup',
                'Record your voice so we can set up your AI voice agent. Download the script, record yourself reading it, and upload your recordings.',
                <svg className="h-5 w-5 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>,
                voiceTasks,
                customer.voiceStage,
              )}

            {showAvatar &&
              renderAddonCard(
                'avatar-addon',
                'AI Avatar Setup',
                'Record a short video so we can create your AI avatar. Download the guide for tips on lighting, framing, and what to say.',
                <svg className="h-5 w-5 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>,
                avatarTasks,
                customer.avatarStage,
              )}
          </div>
        </div>
      )}
    </div>
  );
}
