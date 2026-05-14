'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
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

/**
 * Stage-specific "what happens next" guidance shown when the customer is
 * waiting for the team. Keys are stage names matching Workflow Templates.
 * If a stage isn't here, we fall back to the generic message.
 *
 * `etaDays` is intentionally hardcoded — we don't track real SLAs yet, but
 * customers want to know roughly when to expect movement, not silence.
 */
type StageGuidance = { etaDays: string; bullets: string[] };

/**
 * Keyed by (workflowKey, stage). Lookup falls back to `_default[stage]` for
 * workflows without an explicit entry, and finally to a generic "team is
 * working on it" panel when no match exists. Customer never sees a missing-
 * copy badge — we degrade gracefully.
 *
 * Bullets describe what's happening or will happen. No completion claims
 * (which would mislead — `Customer.Account Created` etc. are mirror flags
 * for task completion, not proof of real-world side effects).
 *
 * Per-workflow split exists because Keyes/BW have an internal-only
 * `Create Designs` step (no customer-facing proof or review email), so the
 * D2C "Getting Started" copy would mislead them.
 */
const STAGE_GUIDANCE: Record<string, Record<string, StageGuidance>> = {
  'D2C-Standard': {
    'Getting Started': {
      etaDays: '1–3 business days',
      bullets: [
        'Our designers create your custom brand kit from your photo, logo, and bio',
        'A senior designer reviews and approves the final look',
        'You’ll get an email when your proof is ready to review',
      ],
    },
    'Review Your Designs': {
      etaDays: '1–2 business days',
      bullets: [
        'Our designers are working on your revision based on the feedback you shared',
        'A senior designer signs off before the new proof goes out',
        'You’ll get an email the moment the updated proof is ready',
      ],
    },
    'Prepare for Onboarding': {
      etaDays: '1–2 business days',
      bullets: [
        'We create your Rejig.ai account using the email you provided',
        'Login credentials are sent to your inbox',
        'Your onboarding call lead will reach out before the scheduled time',
      ],
    },
    'Post Onboarding': {
      etaDays: 'Within the next few days',
      bullets: [
        'Your CSM is putting together a quick recap of your call',
        'You’ll get a follow-up email with everything we covered',
        'When you have a minute, drop us a line on how onboarding went',
      ],
    },
    'Review & Grow': {
      etaDays: 'Within the next 2 weeks',
      bullets: [
        'Your CSM checks in to make sure everything’s working',
        'You’ll be invited to share quick onboarding feedback',
        'Two follow-up calls scheduled over the coming weeks',
      ],
    },
  },
  'B2B-Keyes': {
    'Getting Started': {
      etaDays: '1–2 business days',
      bullets: [
        'Our team is preparing your Rejig account behind the scenes',
        'Your CSM will reach out before your scheduled call',
        'You’ll get login credentials a couple of days before the call',
      ],
    },
    'Prepare for Onboarding': {
      etaDays: '1–2 business days',
      bullets: [
        'We create your Rejig.ai account using the email you provided',
        'Login credentials are sent to your inbox',
        'Your onboarding call lead will reach out before the scheduled time',
      ],
    },
    'Review & Grow': {
      etaDays: 'Within the next 2 weeks',
      bullets: [
        'Your CSM checks in to make sure everything’s working',
        'You’ll be invited to share quick onboarding feedback',
        'Two follow-up calls scheduled over the coming weeks',
      ],
    },
  },
  'B2B-BW': {
    'Getting Started': {
      etaDays: '1–2 business days',
      bullets: [
        'Our team is preparing your Rejig account behind the scenes',
        'Your CSM will reach out before your scheduled call',
        'You’ll get login credentials a couple of days before the call',
      ],
    },
    'Prepare for Onboarding': {
      etaDays: '1–2 business days',
      bullets: [
        'We create your Rejig.ai account using the email you provided',
        'Login credentials are sent to your inbox',
        'Your onboarding call lead will reach out before the scheduled time',
      ],
    },
    'Review & Grow': {
      etaDays: 'Within the next 2 weeks',
      bullets: [
        'Your CSM checks in to make sure everything’s working',
        'You’ll be invited to share quick onboarding feedback',
        'Two follow-up calls scheduled over the coming weeks',
      ],
    },
  },
  // Defensive fallback for stages whose copy is workflow-agnostic. Don't seed
  // `Getting Started` here — it diverges hardest across flows; better to fall
  // through to the generic panel than show wrong copy.
  _default: {
    'Prepare for Onboarding': {
      etaDays: '1–2 business days',
      bullets: [
        'We create your Rejig.ai account using the email you provided',
        'Login credentials are sent to your inbox',
        'Your onboarding call lead will reach out before the scheduled time',
      ],
    },
    'Review & Grow': {
      etaDays: 'Within the next 2 weeks',
      bullets: [
        'Your CSM checks in to make sure everything’s working',
        'You’ll be invited to share quick onboarding feedback',
        'Two follow-up calls scheduled over the coming weeks',
      ],
    },
  },
};

function getStageGuidance(workflowKey: string, stage: string): StageGuidance | null {
  return STAGE_GUIDANCE[workflowKey]?.[stage] ?? STAGE_GUIDANCE._default?.[stage] ?? null;
}

function WaitingPanel({ workflowKey, stage }: { workflowKey: string; stage: string }) {
  const guidance = getStageGuidance(workflowKey, stage);
  if (!guidance) {
    return (
      <div className="flex items-start gap-3 rounded-lg border-l-4 border-l-[#6C4AB6] bg-white px-5 py-4 text-sm text-[#1B2E35]/74 shadow-[0px_4px_12px_#1B2E3514]">
        <svg className="h-5 w-5 shrink-0 text-[#6C4AB6] mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <span>Our team is working on the next step. We&apos;ll email you when something needs your attention.</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border-l-4 border-l-[#6C4AB6] bg-white px-5 py-4 shadow-[0px_4px_12px_#1B2E3514] space-y-4">
      <div className="flex items-start gap-3">
        <svg className="h-5 w-5 shrink-0 text-[#6C4AB6] mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <div>
          <p className="text-sm font-semibold text-[#1B2E35]">Here&apos;s what happens next</p>
          <p className="mt-0.5 text-xs text-[#1B2E35]/60">
            Estimated turnaround: <span className="font-medium text-[#1B2E35]/80">{guidance.etaDays}</span>
          </p>
        </div>
      </div>

      {/* Hollow-circle markers (not green checks) — these are upcoming steps,
          not completed ones. Matches the addon-stage row pattern lower in
          this file. Green checks read as "Completed" everywhere else on the
          portal and were creating a false signal here. */}
      <ul className="space-y-2 ml-8">
        {guidance.bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-sm text-[#1B2E35]/80">
            <span className="shrink-0 mt-0.5 text-base leading-none text-[#1B2E35]/40" aria-hidden="true">
              {'○'}
            </span>
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <div className="ml-8 text-xs text-[#1B2E35]/60 border-t border-[#E0DEE4] pt-3">
        We&apos;ll email you the moment your next step is ready. If anything stalls on our side,
        you&apos;ll get a gentle reminder so nothing slips through the cracks.
      </div>
    </div>
  );
}

/**
 * Tab-content for a completed task. Replaces the underlying TaskRenderer
 * (FormTask, EmbedTask, etc.) which all render their editable UI even for
 * Completed tasks — confusing because the customer sees their filled form
 * and thinks they have to submit again. This panel is the single defensive
 * "done" view used regardless of task type.
 *
 * "View what you submitted" is intentionally absent — each task type stores
 * its data differently (customer fields, Calls record, Airtable attachments,
 * Stripe metadata) and exposing per-task read-only views needs a separate
 * privacy/UX pass.
 */
function CompletedPanel({ task }: { task: Task }) {
  const completedLabel = (() => {
    if (!task.completedAt) return null;
    const ms = new Date(task.completedAt).getTime();
    if (isNaN(ms)) return null;
    // Within last 60s → "Just now" (optimistic-Completed ISO we just stamped).
    if (Date.now() - ms < 60_000) return 'Just now';
    return new Date(ms).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  })();

  return (
    <div className="rounded-lg border border-[#05C68E]/20 bg-[#05C68E]/5 p-6">
      <div className="flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#05C68E]/15">
          <CheckIcon className="h-5 w-5 text-[#05C68E]" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-[#1B2E35]">{task.taskName}</h3>
            <span className="inline-flex items-center rounded-full bg-[#05C68E]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#05C68E]">
              Submitted
            </span>
          </div>
          {completedLabel && (
            <p className="mt-1 text-xs text-[#1B2E35]/60">Completed {completedLabel}</p>
          )}
          <p className="mt-3 text-sm text-[#1B2E35]/74">
            We&apos;ve got everything we need from you on this step.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact "Mar 5 → Mar 8 · 3 days" subtitle for a completed stage.
 * Span is earliest task activation → latest task completion across all
 * tasks in the stage (team + client). Returns null when not all tasks in
 * the stage are Completed so we don't show partial durations.
 */
function completedStageDurationLabel(stage: string, tasks: Task[]): string | null {
  const stageTasks = tasks.filter((t) => t.stage === stage);
  if (stageTasks.length === 0) return null;
  if (stageTasks.some((t) => t.status !== 'Completed')) return null;
  const starts = stageTasks
    .map((t) => t.activatedAt || t.createdAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((n) => !isNaN(n));
  const ends = stageTasks
    .map((t) => t.completedAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((n) => !isNaN(n));
  if (starts.length === 0 || ends.length === 0) return null;
  const startMs = Math.min(...starts);
  const endMs = Math.max(...ends);
  const days = Math.max(0, Math.round((endMs - startMs) / 86_400_000));
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days === 0) return `${fmt(endMs)} · same day`;
  return `${fmt(startMs)} → ${fmt(endMs)} · ${days === 1 ? '1 day' : `${days} days`}`;
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
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  // Post-submit window: client task completes → API marks Completed →
  // handleTaskCompleted (Auto 2 port) promotes dependents Draft→Active.
  // Post-migration this is SYNCHRONOUS inside the PATCH handler — by the
  // time the PATCH returns, the server state is already correct. The
  // optimistic activation here masks the ~200ms router.refresh() round
  // trip so the UI feels instant; the polling fallback exists as a safety
  // net for unusual cases (slow Postgres query, etc.) — short cadence,
  // short cap. Pre-migration this loop ran on a 1.5s tick for up to 20s
  // because Airtable Auto 2 was async (1-3s typical, p99 ~15s).
  const [pollingState, setPollingState] = useState<'idle' | 'polling' | 'capped'>('idle');
  const [pollingDeadline, setPollingDeadline] = useState<number | null>(null);
  const [optimisticActive, setOptimisticActive] = useState<Set<string>>(new Set());

  // Ref mirror so the recursive polling tick can read fresh state without
  // re-creating the timer chain on every optimisticActive change.
  const optimisticActiveRef = useRef(optimisticActive);
  useEffect(() => {
    optimisticActiveRef.current = optimisticActive;
  }, [optimisticActive]);

  useEffect(() => {
    setTasks(initialTasks);
    // Drain optimistic ids the server has now promoted (anything not Draft).
    setOptimisticActive((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const t of initialTasks) {
        if (next.has(t.id) && t.status !== 'Draft') {
          next.delete(t.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
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

  // Does the current stage have anything for the customer to act on?
  // Counts both server-side Active AND optimistic activations (Draft tasks
  // we've pre-activated locally while waiting for Auto 2 to catch up). Without
  // the optimistic set, the post-submit gap renders WaitingPanel by mistake.
  const hasActiveTasks = currentStageTasks.some(
    (t) => t.status === 'Active' || optimisticActive.has(t.id),
  );

  // Stop polling once the server has caught up: optimistic ids drained AND
  // a visible Active task is present server-side. The reconcile effect above
  // drains the ids; this effect detects "we're settled" and ends polling.
  useEffect(() => {
    if (pollingState !== 'polling') return;
    const hasServerVisibleActive = currentStageTasks.some((t) => t.status === 'Active');
    if (optimisticActive.size === 0 && hasServerVisibleActive) {
      setPollingState('idle');
      setPollingDeadline(null);
    }
  }, [currentStageTasks, optimisticActive, pollingState]);

  // Polling tick: router.refresh() every 1.5s until the stop-polling effect
  // settles us, or we hit the 20s cap. At the cap, settle silently to idle
  // if there's no pending optimistic (case B: last visible task in stage,
  // WaitingPanel is the correct end state); else surface the soft "still
  // working" banner so the customer has a manual retry.
  useEffect(() => {
    if (pollingState !== 'polling' || pollingDeadline === null) return;
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      if (Date.now() >= pollingDeadline) {
        setPollingState(optimisticActiveRef.current.size > 0 ? 'capped' : 'idle');
        setPollingDeadline(null);
        return;
      }
      router.refresh();
      timerId = setTimeout(tick, 400);
    };
    timerId = setTimeout(tick, 400);
    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [pollingState, pollingDeadline, router]);

  // Invariant: activeTaskId is always either null or in currentStageTasks.
  // When Auto 2 advances the stage during polling, the prior activeTaskId
  // points at a task in the old stage — reset so the render-time fallback
  // (firstUncompleted) picks a sensible new-stage tab instead of leaving
  // a stale id around.
  useEffect(() => {
    setActiveTaskId(null);
  }, [currentStage]);

  const completedInStage = currentStageTasks.filter((t) => t.status === 'Completed').length;

  /**
   * A task is "locked" if it's Draft AND any of its deps in the current stage
   * are not yet Completed. Using local dep state (not raw task.status) means
   * the UI unlocks the moment the previous task completes — before Airtable's
   * Auto 2 promotes Draft → Active.
   */
  function isTaskLocked(task: Task): boolean {
    if (task.status !== 'Draft') return false;
    if (!task.dependsOn) return false;
    const deps = task.dependsOn.split(',').map((s) => s.trim()).filter(Boolean);
    for (const depName of deps) {
      const dep = currentStageTasks.find((t) => t.taskName === depName);
      if (!dep || dep.status !== 'Completed') return true;
    }
    return false;
  }

  // Mirrors Auto 2's dependency resolution. Returns Draft task ids in the
  // current stage whose deps would all be Completed if `completedId` flips.
  function getOptimisticallyActivatable(completedId: string): string[] {
    const completed = currentStageTasks.find((t) => t.id === completedId);
    if (!completed) return [];
    const completedNames = new Set<string>([completed.taskName]);
    for (const t of currentStageTasks) {
      if (t.status === 'Completed') completedNames.add(t.taskName);
    }
    return currentStageTasks
      .filter((t) => {
        if (t.status !== 'Draft') return false;
        if (!t.dependsOn) return false;
        const deps = t.dependsOn.split(',').map((s) => s.trim()).filter(Boolean);
        return deps.length > 0 && deps.every((dep) => completedNames.has(dep));
      })
      .map((t) => t.id);
  }

  function handleTaskComplete(taskId: string) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, status: 'Completed' as const, completedAt: new Date().toISOString() }
          : t,
      ),
    );
    // Pre-activate dependents whose deps are now (locally) satisfied. Keeps
    // tabs+loader visible during the Auto 2 gap; reconciled when server
    // promotes them.
    const newlyActivatable = getOptimisticallyActivatable(taskId);
    if (newlyActivatable.length > 0) {
      setOptimisticActive((prev) => {
        const next = new Set(prev);
        for (const id of newlyActivatable) next.add(id);
        return next;
      });
      setActiveTaskId(newlyActivatable[0]);
      // Refresh immediately — Auto 2 is sync, server state is correct.
      router.refresh();
      // Brief polling safety net for unusual delays (single tick usually settles).
      setPollingState('polling');
      setPollingDeadline(Date.now() + 3_000);
      return;
    }

    // Parallel-track case: another Active client-visible task already exists
    // in this stage (e.g. D2C Watch Setup Video and Sign In & Reset Password
    // both activate from Send Credentials and run side-by-side). Auto-advance
    // to it rather than parking on the just-completed task — the user has
    // more work to do here and shouldn't have to manually click the next tab.
    const nextActive = currentStageTasks.find(
      (t) => t.id !== taskId
        && t.status === 'Active'
        && (t.taskType === 'Client' || t.taskType === undefined),
    );
    if (nextActive) {
      setActiveTaskId(nextActive.id);
      router.refresh();
      return;
    }

    // Case B: no next CLIENT-VISIBLE task in this stage (e.g. only the
    // hidden Team task Create Designs remains in Getting Started). Render
    // WaitingPanel via a single refresh; no polling needed — nothing
    // client-visible will activate in this stage on this page load.
    setActiveTaskId(taskId);
    router.refresh();
  }

  function handleManualRefresh() {
    router.refresh();
    setPollingState('idle');
    setPollingDeadline(null);
    // Keep optimisticActive — reconciliation drops ids as server confirms.
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
                        className="flex items-center gap-3 rounded-lg border border-[#05C68E]/20 bg-[#05C68E]/10 px-4 py-2.5"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#05C68E]/20">
                          <CheckIcon className="h-3 w-3 text-[#05C68E]" />
                        </span>
                        <span className="flex-1 text-xs text-[#1B2E35]/70">
                          {task.taskName}
                        </span>
                        <span className="text-[10px] font-medium text-[#05C68E] shrink-0 uppercase tracking-wide">
                          Done
                        </span>
                      </div>
                    );
                  }

                  if (task.status === 'Active') {
                    return (
                      <div
                        key={task.id}
                        className="rounded-lg border border-[#E0DEE4] bg-white p-4"
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
      {pollingState === 'polling' && (
        <div className="flex items-center gap-3 rounded-lg border-l-4 border-l-[#6C4AB6] bg-[#6C4AB6]/5 px-5 py-3.5 text-sm font-medium text-[#1B2E35] shadow-[0px_4px_12px_#1B2E3514]">
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#6C4AB6]/30 border-t-[#6C4AB6]" />
          <span>Saving your update — your next step will appear in a moment…</span>
        </div>
      )}
      {pollingState === 'capped' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border-l-4 border-l-[#DABA21] bg-[#DABA21]/10 px-5 py-3.5 text-sm font-medium text-[#1B2E35] shadow-[0px_4px_12px_#1B2E3514]">
          <span>
            This is taking a little longer than usual — your update is saved, but the page needs a refresh.
          </span>
          <button
            type="button"
            onClick={handleManualRefresh}
            className="shrink-0 rounded-md bg-[#6C4AB6] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5a3d9a]"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Progress bar — ALL stages with client-visible tasks, always shown */}
      <div>
      <nav>
        <ol className="flex flex-wrap items-center gap-2 pb-5">
          {progressStages.map((stage, i) => {
            const status = getStageStatus(stage);
            const prevStatus = i > 0 ? getStageStatus(progressStages[i - 1]) : null;
            const durationLabel =
              status === 'completed' ? completedStageDurationLabel(stage, tasks) : null;
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
                {/* Pill is the layout-determining element; subtitle is absolutely
                    positioned below so it doesn't shift the pill off-center
                    relative to the connector. */}
                <div className="relative">
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
                  {durationLabel && (
                    <span className="absolute top-full left-1/2 -translate-x-1/2 mt-1 text-[10px] text-[#1B2E35]/50 whitespace-nowrap">
                      {durationLabel}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </nav>
      </div>

      {/* Current stage content ONLY */}
      <div>
        {currentStageTasks.length > 1 && (
          <div className="mb-4 text-xs font-medium text-[#1B2E35]/40">
            {completedInStage} of {currentStageTasks.length} complete
          </div>
        )}

        {/* If no visible tasks in current stage (e.g., Onboarding Call — team only) */}
        {currentStageTasks.length === 0 && (
          customer.callDate ? (
            <div className="flex items-start gap-3 rounded-lg border-l-4 border-l-[#6C4AB6] bg-white px-5 py-4 text-sm text-[#1B2E35] shadow-[0px_4px_12px_#1B2E3514]">
              <svg className="h-5 w-5 shrink-0 text-[#6C4AB6] mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              <span>
                Your onboarding call is scheduled for {new Date(customer.callDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            </div>
          ) : (
            <WaitingPanel workflowKey={customer.workflowKey} stage={currentStage} />
          )
        )}

        {/* If all visible tasks are completed and team is working (waiting state).
            Suppressed during 'polling' so the post-submit gap keeps tabs+loader
            visible instead of flashing WaitingPanel; 'capped' falls through to
            WaitingPanel honestly (the soft banner above conveys "still in flight"). */}
        {currentStageTasks.length > 0 && !hasActiveTasks && pollingState !== 'polling' && (
          <div className="mb-4">
            <WaitingPanel workflowKey={customer.workflowKey} stage={currentStage} />
          </div>
        )}

        {currentStageTasks.length > 0 && (hasActiveTasks || pollingState === 'polling') && (() => {
          // Active tab: explicit selection wins; else first non-completed; else first
          const explicit = activeTaskId
            ? currentStageTasks.find((t) => t.id === activeTaskId)
            : null;
          const firstUncompleted = currentStageTasks.find((t) => t.status !== 'Completed');
          const activeTab = explicit ?? firstUncompleted ?? currentStageTasks[0];
          const activeTabId = activeTab?.id;

          return (
            <div className="rounded-lg border border-[#E0DEE4] bg-white shadow-[0px_4px_12px_#1B2E3514] overflow-hidden">
              {/* Tab nav */}
              <div className="flex border-b border-[#E0DEE4]">
                {currentStageTasks.map((task, i) => {
                  const isActive = task.id === activeTabId;
                  const isLocked = isTaskLocked(task);
                  const isCompleted = task.status === 'Completed';
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setActiveTaskId(task.id)}
                      className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                        isActive
                          ? 'border-[#6C4AB6] text-[#1B2E35] bg-[#6C4AB6]/5'
                          : 'border-transparent text-[#1B2E35]/60 hover:text-[#1B2E35] hover:bg-[#F7F4EB]'
                      }`}
                    >
                      <span className="flex items-center justify-center gap-2">
                        {isCompleted ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#05C68E]/20">
                            <CheckIcon className="h-3 w-3 text-[#05C68E]" />
                          </span>
                        ) : isLocked ? (
                          <LockIcon className="h-3.5 w-3.5 shrink-0 text-[#1B2E35]/40" />
                        ) : (
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                              isActive
                                ? 'bg-[#6C4AB6] text-white'
                                : 'bg-[#E0DEE4] text-[#1B2E35]/60'
                            }`}
                          >
                            {i + 1}
                          </span>
                        )}
                        <span className="truncate">{task.taskName}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Panels — all mounted (state preserved); only active is visible */}
              {currentStageTasks.map((task) => {
                const isActive = task.id === activeTabId;
                const isCompleted = task.status === 'Completed';
                const isLocked = isTaskLocked(task);
                // Find the blocking task name (best-effort: first listed in Depends On
                // that's not yet Completed within this stage)
                const blockerName = (() => {
                  if (!isLocked || !task.dependsOn) return null;
                  const deps = task.dependsOn.split(',').map((s) => s.trim());
                  for (const depName of deps) {
                    const dep = currentStageTasks.find((t) => t.taskName === depName);
                    if (dep && dep.status !== 'Completed') return depName;
                  }
                  return deps[0] ?? null;
                })();

                return (
                  <div
                    key={task.id}
                    className={isActive ? 'block' : 'hidden'}
                    aria-hidden={!isActive}
                  >
                    <div className="relative p-5">
                      {isCompleted ? (
                        <CompletedPanel task={task} />
                      ) : (
                        <>
                          <div className={isLocked ? 'opacity-50 pointer-events-none select-none' : ''}>
                            <TaskRenderer
                              task={task}
                              customerId={customerId}
                              customer={customer}
                              onComplete={() => handleTaskComplete(task.id)}
                            />
                          </div>
                          {isLocked && (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-[1px]">
                              <div className="rounded-lg border border-[#E0DEE4] bg-white px-4 py-3 text-sm text-[#1B2E35] shadow-[0px_4px_12px_#1B2E3514] flex items-center gap-2">
                                <LockIcon className="h-4 w-4 text-[#1B2E35]/60" />
                                <span>
                                  Complete{' '}
                                  <span className="font-medium">
                                    &ldquo;{blockerName ?? 'the previous step'}&rdquo;
                                  </span>{' '}
                                  first
                                </span>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
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
                'AI Voice',
                'Download the script, record your voice, and upload. We\u2019ll create your AI voice clone.',
                <svg className="h-5 w-5 text-[#6C4AB6]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>,
                voiceTasks,
                customer.voiceStage,
              )}

            {showAvatar &&
              renderAddonCard(
                'avatar-addon',
                'AI Avatar',
                'Record your video and upload. We\u2019ll create your AI avatar and voice clone.',
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
