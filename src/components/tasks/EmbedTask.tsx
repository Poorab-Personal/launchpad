'use client';

import { useState } from 'react';
import type { Task } from '@/types';
export default function EmbedTask({
  task,
  onComplete,
}: {
  task: Task;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [iframeError, setIframeError] = useState(false);

  async function handleComplete() {
    setLoading(true);
    try {
      await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      onComplete();
    } finally {
      setLoading(false);
    }
  }

  const isVideo =
    task.taskName.toLowerCase().includes('video') ||
    task.taskName.toLowerCase().includes('watch');

  return (
    <div className="space-y-4">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}
      {task.embedUrl ? (
        <div className="relative overflow-hidden rounded-lg border border-[#E0DEE4]">
          {iframeLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#F7F4EB]">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#6C4AB6]/30 border-t-[#6C4AB6]" />
            </div>
          )}
          {iframeError ? (
            <div className="flex items-center justify-center p-10 text-sm text-[#1B2E35]/60">
              Failed to load content. Please try refreshing the page.
            </div>
          ) : (
            <iframe
              src={task.embedUrl}
              className="h-[700px] w-full border-0"
              allow="camera; microphone; fullscreen"
              loading="lazy"
              onLoad={() => setIframeLoading(false)}
              onError={() => { setIframeLoading(false); setIframeError(true); }}
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-[#E0DEE4] p-10 text-center">
          <svg className="mb-3 h-10 w-10 text-[#E0DEE4]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m9.86-9.86a4.5 4.5 0 0 0-6.364 0l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
          </svg>
          <p className="text-sm text-[#1B2E35]/60">
            {isVideo ? 'Video will appear here once available.' : 'Booking link will appear here once available.'}
          </p>
        </div>
      )}
      <button
        onClick={handleComplete}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-full bg-[#05C68E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Completing…
          </>
        ) : isVideo ? (
          "I've Watched This"
        ) : (
          'Mark Complete'
        )}
      </button>
    </div>
  );
}
