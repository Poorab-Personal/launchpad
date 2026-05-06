'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { renderCredentialsPreview } from './account-actions';

const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 12;

function generatePassword(): string {
  const arr = new Uint32Array(PASSWORD_LENGTH);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[arr[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

export default function SendCredentialsAction({
  taskId,
  customerId,
  platformEmail,
  firstName,
  portalUrl,
}: {
  taskId: string;
  customerId: string;
  platformEmail: string;
  firstName: string;
  portalUrl: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState(() => generatePassword());
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewPending, startPreview] = useTransition();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce preview re-render so we don't hammer the server action on
  // every keystroke. 300ms feels responsive without being chatty.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      startPreview(async () => {
        try {
          const html = await renderCredentialsPreview({
            firstName,
            portalUrl,
            platformEmail,
            password,
          });
          setPreviewHtml(html);
        } catch (err) {
          console.warn('Preview render failed:', err);
        }
      });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [password, platformEmail, firstName, portalUrl]);

  const platformEmailMissing = !platformEmail;
  const canSend = !platformEmailMissing && password.length > 0 && !sending && !sent;

  async function handleSend() {
    setError(null);
    setSending(true);
    try {
      const res = await fetch('/api/workspace/send-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, customerId, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? 'Send failed');
      }
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
        <label
          htmlFor="temp-password"
          className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold mb-1.5"
        >
          Temporary Password
        </label>
        <div className="flex items-center gap-2">
          <input
            id="temp-password"
            type="text"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={sending || sent}
            className="flex-1 rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-sm text-[#1B2E35] font-mono focus:outline-none focus:ring-2 focus:ring-[#6C4AB6]/30 focus:border-[#6C4AB6] disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setPassword(generatePassword())}
            disabled={sending || sent}
            title="Generate new random password"
            className="rounded-lg border border-[#E0DEE4] bg-white px-3 py-2 text-xs text-[#1B2E35]/70 hover:border-[#6C4AB6] hover:text-[#6C4AB6] disabled:opacity-50"
          >
            ↻ Generate
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs uppercase tracking-wide text-[#1B2E35]/60 font-semibold">
            Email Preview
          </label>
          {previewPending && (
            <span className="text-[10px] text-[#1B2E35]/40">Rendering…</span>
          )}
        </div>
        <div className="rounded-lg border border-[#E0DEE4] bg-[#F7F4EB] overflow-hidden">
          {previewHtml ? (
            <iframe
              title="Email preview"
              srcDoc={previewHtml}
              sandbox=""
              className="w-full h-[420px] bg-white"
            />
          ) : (
            <div className="p-4 text-xs text-[#1B2E35]/40 italic text-center">
              Loading preview…
            </div>
          )}
        </div>
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
