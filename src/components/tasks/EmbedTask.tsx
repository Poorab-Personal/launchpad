'use client';

import { useState, useEffect, useCallback } from 'react';
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
  const [booked, setBooked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isVideo =
    task.taskName.toLowerCase().includes('video') ||
    task.taskName.toLowerCase().includes('watch');

  const isCalendly = task.embedUrl?.includes('calendly.com') ?? false;

  const handleCalendlyBooked = useCallback(async () => {
    setBooked(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Booking saved but task status update failed. Please refresh.');
      }
      setTimeout(() => onComplete(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong saving your booking.');
    } finally {
      setLoading(false);
    }
  }, [task.id, onComplete]);

  // Listen for Calendly's postMessage event when booking completes
  useEffect(() => {
    if (!isCalendly) return;
    function handleMessage(event: MessageEvent) {
      if (event.data?.event === 'calendly.event_scheduled') {
        handleCalendlyBooked();
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isCalendly, handleCalendlyBooked]);

  async function handleComplete() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Failed to mark task complete');
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // Booking confirmed state
  if (booked) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg bg-[#05C68E]/10 border border-[#05C68E]/20 px-5 py-4">
          <svg className="h-5 w-5 text-[#05C68E] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          <span className="text-sm font-medium text-[#1B2E35]">
            Booking confirmed! We&apos;ll send you a confirmation email with the details.
          </span>
        </div>
      </div>
    );
  }

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
              className={`w-full border-0 ${isCalendly ? 'h-[800px]' : 'h-[700px]'}`}
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

      {error && (
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          {error}
        </div>
      )}

      {/* Only show Mark Complete for non-Calendly tasks (videos, etc.) */}
      {!isCalendly && (
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
      )}
    </div>
  );
}
