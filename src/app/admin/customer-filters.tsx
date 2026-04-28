'use client';

import { useRouter, useSearchParams } from 'next/navigation';

const TYPES = ['D2C', 'B2B'];

const STAGE_ORDER = [
  'Getting Started',
  'Review Your Designs',
  'Prepare for Onboarding',
  'Onboarding Call',
  'Post Onboarding',
  'Review & Grow',
  'Done',
];

interface Props {
  stageCounts: Record<string, number>;
  channels: string[];
  totalCustomers: number;
}

export default function CustomerFilters({ stageCounts, channels, totalCustomers }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeStage = searchParams.get('stage') ?? '';

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.replace(`/admin?${params.toString()}`);
  }

  // Order stages: known order first, then any extras from data
  const orderedStages = STAGE_ORDER.filter((s) => s in stageCounts);
  for (const s of Object.keys(stageCounts)) {
    if (!orderedStages.includes(s)) orderedStages.push(s);
  }

  return (
    <div className="space-y-4 mb-6">
      {/* Pipeline overview cards */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {/* "All" card */}
        <button
          onClick={() => setParam('stage', '')}
          className={`shrink-0 rounded-lg border px-4 py-3 text-center transition-colors min-w-[90px] ${
            !activeStage
              ? 'border-[#6C4AB6]/30 bg-[#6C4AB6]/5 ring-1 ring-[#6C4AB6]/20'
              : 'border-[#E0DEE4] bg-white hover:bg-[#F7F4EB]'
          }`}
        >
          <div className={`text-xl font-bold ${!activeStage ? 'text-[#6C4AB6]' : 'text-[#1B2E35]'}`}>
            {totalCustomers}
          </div>
          <div className="text-[10px] font-medium text-[#1B2E35]/40 uppercase tracking-wide">All</div>
        </button>

        {orderedStages.map((stage) => {
          const count = stageCounts[stage] ?? 0;
          const isActive = activeStage === stage;
          const isDone = stage === 'Done';

          return (
            <button
              key={stage}
              onClick={() => setParam('stage', isActive ? '' : stage)}
              className={`shrink-0 rounded-lg border px-4 py-3 text-center transition-colors min-w-[90px] ${
                isActive
                  ? isDone
                    ? 'border-[#05C68E]/30 bg-[#05C68E]/5 ring-1 ring-[#05C68E]/20'
                    : 'border-[#6C4AB6]/30 bg-[#6C4AB6]/5 ring-1 ring-[#6C4AB6]/20'
                  : 'border-[#E0DEE4] bg-white hover:bg-[#F7F4EB]'
              }`}
            >
              <div className={`text-xl font-bold ${
                isActive
                  ? isDone ? 'text-[#05C68E]' : 'text-[#6C4AB6]'
                  : count > 0 ? 'text-[#1B2E35]' : 'text-[#1B2E35]/20'
              }`}>
                {count}
              </div>
              <div className="text-[10px] font-medium text-[#1B2E35]/40 uppercase tracking-wide leading-tight whitespace-nowrap">
                {stage}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filter dropdowns */}
      <div className="flex gap-3">
        <select
          value={searchParams.get('type') ?? ''}
          onChange={(e) => setParam('type', e.target.value)}
          className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
        >
          <option value="">All Types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        {channels.length > 1 && (
          <select
            value={searchParams.get('channel') ?? ''}
            onChange={(e) => setParam('channel', e.target.value)}
            className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-1.5 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
          >
            <option value="">All Channels</option>
            {channels.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
