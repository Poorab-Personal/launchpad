'use client';

import { useState } from 'react';
import type { Task, Customer } from '@/types';
import { resolveTempPassword } from '@/lib/temp-password';

const APP_URL = 'https://app.rejig.ai';

/**
 * Customer-portal renderer for the "Sign In & Reset Password" task.
 *
 * Shows the platform email + temp password (derived from customer name —
 * same value the credentials email used) with copy buttons, plus a single
 * "Launch Rejig" button. Click flow:
 *   1. PATCH task → Completed (await success)
 *   2. window.open(app.rejig.ai/?email=…) — email prepopulated
 *   3. onComplete() — TaskList advances stage; Auto 2 fires Launched terminal;
 *      portal swaps to <PortalHandyPage> on the next render.
 * If PATCH fails, the tab does NOT open and the error is shown — keeps the
 * portal state consistent with what actually happened server-side.
 */
export default function SignInTask({
  task,
  customer,
  onComplete,
}: {
  task: Task;
  customer?: Customer;
  onComplete: () => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'email' | 'password' | null>(null);

  const email = customer?.platformEmail ?? '';
  const password = customer
    ? resolveTempPassword(customer)
    : resolveTempPassword({ tempPassword: null, name: '', platformEmail: '' });
  const launchUrl = email
    ? `${APP_URL}/?email=${encodeURIComponent(email)}`
    : APP_URL;

  async function copy(text: string, kind: 'email' | 'password') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // clipboard unavailable — the value is selectable in the input either way
    }
  }

  async function handleLaunch() {
    setLaunching(true);
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
      // PATCH succeeded — now open the product. Use window.open in user
      // gesture context so popup blockers don't intervene.
      window.open(launchUrl, '_blank', 'noopener,noreferrer');
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-5">
      {task.instructions && (
        <p className="text-[#1B2E35]/70 leading-relaxed">{task.instructions}</p>
      )}

      <div className="rounded-lg border border-[#E0DEE4] bg-white p-5 space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5">
            Your login email
          </label>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={email}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-3 py-2 text-sm text-[#1B2E35] font-mono focus:outline-none"
            />
            <button
              type="button"
              onClick={() => copy(email, 'email')}
              className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6]"
            >
              {copied === 'email' ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5">
            Temporary password
          </label>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={password}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-3 py-2 text-sm text-[#1B2E35] font-mono focus:outline-none"
            />
            <button
              type="button"
              onClick={() => copy(password, 'password')}
              className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6]"
            >
              {copied === 'password' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-[#1B2E35]/50">
            You&apos;ll be prompted to set a new password on first sign in.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleLaunch}
        disabled={launching || !email}
        className="block w-full rounded-full bg-[#6C4AB6] px-6 py-3 text-center text-sm font-semibold text-white hover:bg-[#5A3DA5] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {launching ? 'Launching…' : 'Launch Rejig →'}
      </button>

      {error && (
        <div className="rounded-lg border border-[#EC531A]/30 bg-[#EC531A]/5 px-4 py-3 text-sm text-[#EC531A]">
          {error}
        </div>
      )}
    </div>
  );
}
