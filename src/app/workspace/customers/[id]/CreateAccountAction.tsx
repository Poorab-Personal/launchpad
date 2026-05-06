'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markAccountCreated } from './account-actions';

export default function CreateAccountAction({
  taskId,
  customerId,
  initialPlatformEmail,
}: {
  taskId: string;
  customerId: string;
  /** Pre-fill from Customer.platformEmail if a previous attempt set it. */
  initialPlatformEmail: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState(initialPlatformEmail);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Platform email is required.');
      return;
    }
    startTransition(async () => {
      const res = await markAccountCreated(taskId, customerId, trimmed);
      if (!res.ok) {
        setError(res.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label
          htmlFor="platform-email"
          className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5"
        >
          Platform Email
        </label>
        <input
          id="platform-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="agent@example.com"
          disabled={pending}
          className="w-full rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] placeholder:text-[#1B2E35]/30 focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/30 focus:border-[#6C4AB6] disabled:opacity-50"
        />
        <p className="mt-1 text-[11px] text-[#1B2E35]/50">
          The address the agent will sign into app.rejig.ai with.
        </p>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? 'Saving…' : 'Mark Account Created'}
      </button>
      {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
    </form>
  );
}
