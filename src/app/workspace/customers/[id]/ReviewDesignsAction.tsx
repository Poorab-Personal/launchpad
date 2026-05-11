'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markTaskComplete } from './actions';

type Mode = 'idle' | 'requesting-changes';

export default function ReviewDesignsAction({
  customerId,
  taskId,
}: {
  customerId: string;
  taskId: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTransition, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pending = busy || pendingTransition;

  function handleApprove() {
    setError(null);
    startTransition(async () => {
      const res = await markTaskComplete(taskId, customerId);
      if (!res.ok) {
        setError(res.error);
      } else {
        router.refresh();
      }
    });
  }

  async function handleSubmitChanges() {
    if (!feedback.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/workspace/design-review-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, customerId, feedback: feedback.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Request failed');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send feedback');
      setBusy(false);
    }
  }

  if (mode === 'requesting-changes') {
    return (
      <div className="space-y-2">
        <label htmlFor="senior-feedback" className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold">
          Feedback for designer
        </label>
        <textarea
          id="senior-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Describe what needs to change — colors, layout, copy, anything specific."
          rows={4}
          className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/40 focus:border-[#6C4AB6] focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/20"
        />
        <p className="text-xs text-[#1B2E35]/50">
          A new revision task will appear in the original designer&apos;s queue with this feedback.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={handleSubmitChanges}
            disabled={pending || !feedback.trim()}
            className="flex-1 rounded-full bg-[#EC531A] px-4 py-2 text-sm font-medium text-white hover:bg-[#D14617] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Sending…' : 'Send to designer'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('idle');
              setFeedback('');
              setError(null);
            }}
            disabled={pending}
            className="rounded-full border border-[#1B2E35]/20 bg-white px-4 py-2 text-sm font-medium text-[#1B2E35] hover:bg-[#F7F4EB] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleApprove}
        disabled={pending}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pendingTransition ? 'Approving…' : 'Approve & Mark Complete'}
      </button>
      <button
        type="button"
        onClick={() => setMode('requesting-changes')}
        disabled={pending}
        className="w-full rounded-full border border-[#EC531A]/40 bg-white px-4 py-2 text-sm font-medium text-[#EC531A] hover:bg-[#EC531A]/5 disabled:opacity-50"
      >
        Request Changes
      </button>
      {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
    </div>
  );
}
