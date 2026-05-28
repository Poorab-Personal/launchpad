/**
 * hCaptcha server-side verification.
 *
 * Used by `POST /api/agent-lookup` (Phase 3) to gate the brokerage landing
 * page against scripted abuse. The agent's browser sends the token from the
 * hCaptcha widget; this helper posts it to hCaptcha's siteverify endpoint
 * with our server-only secret.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2 step 1 and §6.
 *
 * Fail-closed policy: any network error or non-OK response returns false.
 * Configuration error (missing HCAPTCHA_SECRET) throws on first call — that
 * indicates a deploy-time misconfiguration, not a runtime concern. The check
 * lives inside verifyHCaptcha (not at module load) so build-time page-data
 * collection can import the agent-lookup route in environments that haven't
 * provisioned the secret yet (preview/dev). It is NOT a production bypass:
 * any real call still throws loudly when the secret is absent.
 */

const HCAPTCHA_SITEVERIFY_URL = 'https://api.hcaptcha.com/siteverify';

interface SiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  credit?: boolean;
  'error-codes'?: string[];
  score?: number;
  score_reason?: string[];
}

export async function verifyHCaptcha(
  token: string,
  remoteip?: string,
): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret) {
    // Loud, not silent: a missing secret is a deploy-time misconfiguration.
    // We throw rather than returning false so it surfaces immediately instead
    // of looking like a (recoverable) failed captcha.
    throw new Error('HCAPTCHA_SECRET is required');
  }
  if (!token) return false;

  const body = new URLSearchParams({
    secret,
    response: token,
  });
  if (remoteip) body.set('remoteip', remoteip);

  try {
    const res = await fetch(HCAPTCHA_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      console.error(
        `[captcha] siteverify HTTP ${res.status} ${res.statusText}`,
      );
      return false;
    }

    const data = (await res.json()) as SiteverifyResponse;
    if (!data.success) {
      console.warn(
        `[captcha] siteverify rejected token: ${JSON.stringify(data['error-codes'] ?? [])}`,
      );
    }
    return Boolean(data.success);
  } catch (err) {
    // Network error / DNS failure / etc. Fail closed.
    console.error('[captcha] siteverify network error', err);
    return false;
  }
}
