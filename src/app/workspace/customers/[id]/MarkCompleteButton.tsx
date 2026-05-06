'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markTaskComplete } from './actions';

export default function MarkCompleteButton({
  taskId,
  customerId,
  label = 'Mark Complete',
}: {
  taskId: string;
  customerId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
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

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={handleClick}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50"
      >
        {pending ? 'Saving…' : label}
      </button>
      {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
    </div>
  );
}
