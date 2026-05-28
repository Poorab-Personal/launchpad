'use client';

/**
 * Brokerage landing verification form.
 *
 * email + hCaptcha → POST /api/agent-lookup. On match, navigate to the portal
 * redirect URL; on no-match, render the brokerage's support copy inline.
 *
 * hCaptcha widget: no React package is installed, so we load the official
 * script with explicit render and mount the widget by id. siteKey comes from
 * NEXT_PUBLIC_HCAPTCHA_SITE_KEY (passed from the server component). If it's
 * unset we render a "captcha not configured" placeholder rather than crashing
 * the page (see the hCaptcha note in the Phase 3 spec).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const HCAPTCHA_SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?render=explicit';
const HCAPTCHA_SCRIPT_ID = 'hcaptcha-explicit';

interface HCaptchaApi {
  render: (
    container: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    hcaptcha?: HCaptchaApi;
  }
}

interface Support {
  name: string | null;
  email: string | null;
  phone: string | null;
}

type LookupResponse =
  | { match: true; redirect: string }
  | { match: false; support: Support }
  | { error: string };

function loadHCaptchaScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.hcaptcha) return resolve();

    const existing = document.getElementById(HCAPTCHA_SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('hCaptcha failed to load')));
      return;
    }

    const script = document.createElement('script');
    script.id = HCAPTCHA_SCRIPT_ID;
    script.src = HCAPTCHA_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('hCaptcha failed to load'));
    document.head.appendChild(script);
  });
}

export default function EmailForm({
  slug,
  siteKey,
}: {
  slug: string;
  siteKey: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState<Support | null>(null);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Mount the hCaptcha widget once the script is ready.
  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    loadHCaptchaScript()
      .then(() => {
        if (cancelled || !window.hcaptcha || !widgetRef.current) return;
        if (widgetIdRef.current !== null) return; // already rendered
        widgetIdRef.current = window.hcaptcha.render(widgetRef.current, {
          sitekey: siteKey,
          callback: (t: string) => setToken(t),
          'expired-callback': () => setToken(null),
          'error-callback': () => setToken(null),
        });
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the captcha. Please refresh and try again.');
      });

    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  const resetCaptcha = useCallback(() => {
    setToken(null);
    if (window.hcaptcha && widgetIdRef.current !== null) {
      window.hcaptcha.reset(widgetIdRef.current);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNoMatch(null);

    if (!email.trim()) {
      setError('Please enter your email.');
      return;
    }
    if (siteKey && !token) {
      setError('Please complete the captcha.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/agent-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), slug, hcaptchaToken: token ?? '' }),
      });
      const data = (await res.json()) as LookupResponse;

      if (!res.ok || 'error' in data) {
        setError(('error' in data && data.error) || 'Something went wrong. Please try again.');
        resetCaptcha();
        return;
      }

      if (data.match) {
        router.push(data.redirect);
        return;
      }

      // No match — show support copy, let them retry with another email.
      setNoMatch(data.support);
      resetCaptcha();
    } catch {
      setError('Network error. Please try again.');
      resetCaptcha();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-[#1B2E35]">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setNoMatch(null);
            setError(null);
          }}
          placeholder="you@brokerage.com"
          className="mt-1 w-full rounded-lg border border-[#E0DEE4] px-3 py-2 text-sm text-[#1B2E35] focus:border-[#6C4AB6] focus:outline-none focus:ring-1 focus:ring-[#6C4AB6]"
        />
      </div>

      {/* hCaptcha widget (or placeholder if not configured) */}
      {siteKey ? (
        <div ref={widgetRef} />
      ) : (
        <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          Captcha is not configured for this environment
          (NEXT_PUBLIC_HCAPTCHA_SITE_KEY missing). Verification will fail until
          it is set.
        </p>
      )}

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {noMatch && (
        <div className="rounded-lg bg-[#F7F4EB] border border-[#E0DEE4] px-3 py-3 text-sm text-[#1B2E35]/80">
          <p>
            We don&apos;t see you in this brokerage&apos;s roster. If your office
            uses a secondary email for you, try that
            {noMatch.name || noMatch.email ? ' — or contact ' : '.'}
            {noMatch.name && <span className="font-medium">{noMatch.name}</span>}
            {noMatch.email && (
              <>
                {' '}
                at{' '}
                <a className="text-[#6C4AB6] underline" href={`mailto:${noMatch.email}`}>
                  {noMatch.email}
                </a>
              </>
            )}
            {noMatch.phone && <> ({noMatch.phone})</>}
            {(noMatch.name || noMatch.email) && '.'}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-[#6C4AB6] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#5a3d9c] disabled:opacity-50"
      >
        {submitting ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );
}
