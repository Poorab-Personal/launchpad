'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Account Creator action panel for the "Send Credentials" task.
 *
 * The temp password is pre-filled with the derived default (or the stored
 * value if already sent) but is editable — the Account Creator can correct
 * an odd/empty-name derivation before sending. Whatever's in the box is what
 * gets emailed AND persisted on the customer, so the email template, portal
 * Sign In task, and Handy page all read back the exact value that went out.
 */
export default function SendCredentialsAction({
  taskId,
  customerId,
  platformEmail,
  derivedPassword,
}: {
  taskId: string;
  customerId: string;
  platformEmail: string;
  derivedPassword: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState(derivedPassword);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const platformEmailMissing = !platformEmail;
  const passwordInvalid = password.trim().length < 8;
  const canSend = !platformEmailMissing && !passwordInvalid && !sending && !sent;

  async function handleSend() {
    setError(null);
    setSending(true);
    try {
      const res = await fetch('/api/workspace/send-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, customerId, password: password.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Send failed');
      setSent(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5">
          Platform Email
        </label>
        <div className="rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-3 py-2 text-sm text-[#1B2E35] font-mono">
          {platformEmail || (
            <span className="text-[#EC531A] not-italic">
              Not set — Create Account step must run first.
            </span>
          )}
        </div>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5">
          Temp Password
        </label>
        <input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={sent}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] px-3 py-2 text-sm text-[#1B2E35] font-mono focus:outline-none focus:ring-2 focus:ring-[#05C68E]/40 disabled:opacity-60"
        />
        <p className="mt-1 text-xs text-[#1B2E35]/50">
          Pre-filled from the customer&apos;s name — edit if it looks wrong. Use this
          same password when creating the customer in app.rejig.ai.
        </p>
        {passwordInvalid && (
          <p className="mt-1 text-xs text-[#EC531A]">
            Password must be at least 8 characters.
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={!canSend}
        onClick={handleSend}
        className="w-full rounded-full bg-[#05C68E] px-4 py-2 text-sm font-medium text-white hover:bg-[#04946A] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {sent ? 'Sent ✓' : sending ? 'Sending…' : 'Send Credentials Email'}
      </button>
      {error && <p className="text-sm text-[#EC531A] text-center">{error}</p>}
    </div>
  );
}
