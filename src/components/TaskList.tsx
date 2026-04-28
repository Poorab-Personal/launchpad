'use client';

import { useEffect, useState } from 'react';
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

  // Only show client-visible tasks
  const visibleTasks = tasks.filter((t) => t.visibleToClient);

  // ALL unique stages sorted by stageOrder (for progress bar)
  // Build stage order map — use the highest non-zero stageOrder for each stage
  // (revision tasks have stageOrder=0, so we skip those to avoid misordering)
  const stageMap = new Map<string, number>();
  for (const t of tasks) {
    const existing = stageMap.get(t.stage) ?? 0;
    if (t.stageOrder > existing) stageMap.set(t.stage, t.stageOrder);
  }
  const allStages = [...stageMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([stage]) => stage);

  // Only stages with client-visible tasks appear in the progress bar
  const progressStages = allStages.filter((stage) =>
    visibleTasks.some((t) => t.stage === stage),
  );

  function getStageStatus(stage: string) {
    const currentIdx = allStages.indexOf(currentStage);
    const stageIdx = allStages.indexOf(stage);
    if (stageIdx < currentIdx) return 'completed';
    if (stageIdx === currentIdx) return 'active';
    return 'upcoming';
  }

  // Current stage tasks only
  const currentStageTasks = visibleTasks
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

      {/* ── Add-Ons Section (MOCK — hardcoded for UX review) ──────────── */}
      {/* TODO: Remove this mock and drive from task data once UX is approved */}
      <div className="border-t border-[#E0DEE4] pt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[#1B2E35]">Your Add-Ons</h2>
          <span className="text-xs font-medium text-[#1B2E35]/40">0 of 2 complete</span>
        </div>

        <div className="space-y-4">
          {/* Voice Add-On */}
          <div className="rounded-lg border border-[#E0DEE4] bg-white p-5">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6C4AB6]/10">
                <svg className="h-5 w-5 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-[#1B2E35]">AI Voice Setup</h3>
                <p className="mt-1 text-xs text-[#1B2E35]/60">
                  Record your voice so we can set up your AI voice agent. Download the script, record yourself reading it, and upload your recordings.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="inline-flex items-center gap-1.5 rounded-full border border-[#E0DEE4] bg-white px-3.5 py-1.5 text-xs font-medium text-[#1B2E35] hover:bg-[#F7F4EB] transition-colors">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                    </svg>
                    View Script
                  </button>
                  <button className="inline-flex items-center gap-1.5 rounded-full bg-[#05C68E] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#04946A] transition-colors">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                    </svg>
                    Upload Recordings
                  </button>
                  <span className="inline-flex items-center text-xs text-[#1B2E35]/40">or share a Drive link</span>
                </div>
              </div>
              <span className="inline-flex items-center rounded-full bg-[#DABA21]/10 px-2.5 py-1 text-[10px] font-medium text-[#DABA21]">
                Pending
              </span>
            </div>
          </div>

          {/* Avatar Add-On */}
          <div className="rounded-lg border border-[#E0DEE4] bg-white p-5">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6C4AB6]/10">
                <svg className="h-5 w-5 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-[#1B2E35]">AI Avatar Setup</h3>
                <p className="mt-1 text-xs text-[#1B2E35]/60">
                  Record a short video so we can create your AI avatar. Download the guide for tips on lighting, framing, and what to say.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="inline-flex items-center gap-1.5 rounded-full border border-[#E0DEE4] bg-white px-3.5 py-1.5 text-xs font-medium text-[#1B2E35] hover:bg-[#F7F4EB] transition-colors">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                    </svg>
                    View Guide
                  </button>
                  <button className="inline-flex items-center gap-1.5 rounded-full bg-[#05C68E] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#04946A] transition-colors">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                    </svg>
                    Upload Video
                  </button>
                  <span className="inline-flex items-center text-xs text-[#1B2E35]/40">or share a Drive link</span>
                </div>
              </div>
              <span className="inline-flex items-center rounded-full bg-[#DABA21]/10 px-2.5 py-1 text-[10px] font-medium text-[#DABA21]">
                Pending
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
