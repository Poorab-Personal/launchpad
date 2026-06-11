'use client';

/**
 * Test-mode brokerage landing form (two-field).
 *
 * Sibling of the prod EmailForm — reuses the same styled inputs, hCaptcha
 * widget, and brand theme, but exposes TWO fields for internal testers:
 *
 *   1. Agent to simulate — a dropdown of the brokerage's roster agents
 *      (name → lookup email), since the tester doesn't know real agent emails.
 *      The selected option's value (the agent email) is sent as `agentEmail`
 *      for the roster lookup, so the created test customer carries that agent's
 *      real pre-pop data (name, bio, MLS, etc.).
 *   2. Your email (receives test emails) — the tester's own inbox. Becomes the
 *      created customer's contact + platform email, so EVERY downstream stage
 *      email (welcome / design / credentials / …) routes to the tester and
 *      never to the real agent.
 *
 * POSTs { slug, agentEmail, receiveEmail, hcaptchaToken, testMode: true } to
 * the same /api/agent-lookup route (additive testMode branch). On match (new
 * or recovered) it navigates to the portal redirect; on no-match it shows the
 * brokerage support copy inline, same as prod.
 *
 * hCaptcha gate is REAL here — same widget, same server verify.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LandingTheme } from '../EmailForm';

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

/** One roster agent for the simulate-agent dropdown: value = lookup email. */
export interface AgentOption {
  value: string;
  label: string;
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

export default function TestEmailForm({
  slug,
  siteKey,
  theme,
  agents,
}: {
  slug: string;
  siteKey: string;
  theme: LandingTheme;
  /** Brokerage roster agents for the simulate-agent dropdown. */
  agents: AgentOption[];
}) {
  const router = useRouter();
  const [agentEmail, setAgentEmail] = useState(''); // selected roster agent's lookup email
  const [receiveEmail, setReceiveEmail] = useState(''); // cleared by default — never pre-fill the agent's email here
  const [token, setToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState<Support | null>(null);
  const [agentFocused, setAgentFocused] = useState(false);
  const [receiveFocused, setReceiveFocused] = useState(false);
  const [buttonHovered, setButtonHovered] = useState(false);

  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Mount the hCaptcha widget once the script is ready (identical to prod form).
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

    if (!agentEmail.trim()) {
      setError('Please select an agent to simulate.');
      return;
    }
    if (!receiveEmail.trim()) {
      setError('Please enter your email (where test emails should go).');
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
        body: JSON.stringify({
          slug,
          agentEmail: agentEmail.trim(),
          receiveEmail: receiveEmail.trim(),
          hcaptchaToken: token ?? '',
          testMode: true,
        }),
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

      // No match on the agent email — show support copy, let them retry.
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
      {/* Field 1 — agent to simulate (real roster data source) */}
      <div>
        <label
          htmlFor="agentEmail"
          className="block text-xs font-semibold uppercase"
          style={{ color: theme.ink, letterSpacing: '0.08em', opacity: 0.7 }}
        >
          Agent to simulate
        </label>
        <select
          id="agentEmail"
          name="agentEmail"
          required
          value={agentEmail}
          onChange={(e) => {
            setAgentEmail(e.target.value);
            setNoMatch(null);
            setError(null);
          }}
          onFocus={() => setAgentFocused(true)}
          onBlur={() => setAgentFocused(false)}
          className="mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm focus:outline-none"
          style={{
            color: agentEmail ? theme.ink : `${theme.ink}99`,
            backgroundColor: theme.surface,
            borderColor: agentFocused ? theme.primary : `${theme.accent}80`,
            boxShadow: agentFocused ? `0 0 0 1px ${theme.primary}` : 'none',
          }}
        >
          <option value="" disabled>
            {agents.length
              ? 'Select an agent…'
              : 'No roster agents available'}
          </option>
          {agents.map((a) => (
            <option key={a.value} value={a.value} style={{ color: theme.ink }}>
              {a.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px]" style={{ color: theme.ink, opacity: 0.55 }}>
          Loads this agent&apos;s real roster pre-pop data.
        </p>
      </div>

      {/* Field 2 — tester's own email (receives all downstream emails) */}
      <div>
        <label
          htmlFor="receiveEmail"
          className="block text-xs font-semibold uppercase"
          style={{ color: theme.ink, letterSpacing: '0.08em', opacity: 0.7 }}
        >
          Your email (receives test emails)
        </label>
        <input
          id="receiveEmail"
          name="receiveEmail"
          type="email"
          autoComplete="email"
          required
          value={receiveEmail}
          onChange={(e) => {
            setReceiveEmail(e.target.value);
            setNoMatch(null);
            setError(null);
          }}
          onFocus={() => setReceiveFocused(true)}
          onBlur={() => setReceiveFocused(false)}
          placeholder="you@rejig.ai"
          className="mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm focus:outline-none"
          style={{
            color: theme.ink,
            backgroundColor: theme.surface,
            borderColor: receiveFocused ? theme.primary : `${theme.accent}80`,
            boxShadow: receiveFocused ? `0 0 0 1px ${theme.primary}` : 'none',
          }}
        />
        <p className="mt-1 text-[11px]" style={{ color: theme.ink, opacity: 0.55 }}>
          The test customer is created with this email, so every stage email
          comes to you — never the real agent.
        </p>
      </div>

      {/* hCaptcha widget — omitted entirely when siteKey is empty
          (kill-switch; server matches via HCAPTCHA_SECRET unset). */}
      {siteKey ? <div ref={widgetRef} /> : null}

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {noMatch && (
        <div
          className="rounded-lg border px-3 py-3 text-sm"
          style={{
            backgroundColor: `${theme.accent}1f`,
            borderColor: `${theme.accent}80`,
            color: theme.ink,
          }}
        >
          <p>
            No roster match for that agent email. Double-check the agent email
            you&apos;re loading
            {noMatch.name || noMatch.email ? ' — or contact ' : '.'}
            {noMatch.name && <span className="font-medium">{noMatch.name}</span>}
            {noMatch.email && (
              <>
                {' '}
                at{' '}
                <a
                  className="underline"
                  style={{ color: theme.primary }}
                  href={`mailto:${noMatch.email}`}
                >
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
        onMouseEnter={() => setButtonHovered(true)}
        onMouseLeave={() => setButtonHovered(false)}
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
        style={{
          backgroundColor: buttonHovered ? theme.primaryHover : theme.primary,
        }}
      >
        {submitting ? 'Checking…' : 'Start test session'}
      </button>
    </form>
  );
}
