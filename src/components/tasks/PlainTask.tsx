'use client';

import { useState } from 'react';
import type { Task } from '@/types';
export default function PlainTask({
  task,
  onComplete,
}: {
  task: Task;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="space-y-4">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
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
        ) : (
          'Mark Complete'
        )}
      </button>
    </div>
  );
}
