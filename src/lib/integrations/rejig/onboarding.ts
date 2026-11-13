import type { RejigCustomerPayload } from '@/lib/rejig-sync/payload';

/**
 * Rejig onboarding staging API: LaunchPad POSTs one customer, Rejig holds it
 * in a temporary table until the Account Creator finishes it in Rejig's
 * "Create Account (New)" screen. Plan: docs/plans/rejig-account-sync.md.
 *
 * URLs are constants, not env — same reason as client.ts (an endpoint in env
 * once produced a doubled-path 404). Only the API keys live in env, and the
 * prod key is set in Vercel **Production only** so a Preview build (which
 * shares the prod DB) can never reach Rejig prod.
 */

export type RejigEnv = 'dev' | 'prod';

const ENDPOINTS: Record<RejigEnv, string | null> = {
  dev: 'https://devapi.rejig.ai/onboarding/source/customers',
  // Prod base URL not confirmed by Rejig yet. Second lock alongside the
  // missing REJIG_ONBOARDING_PROD_API_KEY.
  prod: null,
};

const KEY_VARS: Record<RejigEnv, string> = {
  dev: 'REJIG_ONBOARDING_DEV_API_KEY',
  prod: 'REJIG_ONBOARDING_PROD_API_KEY',
};

const TIMEOUT_MS = 15_000;
const MAX_LOGGED_BODY = 4_000;

export type RejigSyncOutcome =
  | 'created'
  | 'updated'
  | 'locked'
  | 'domain_exists'
  | 'validation_error'
  | 'auth_error'
  | 'http_error'
  | 'network_error';

export type RejigSyncResult = {
  outcome: RejigSyncOutcome;
  ok: boolean;
  httpStatus: number | null;
  /** Rejig's error code, e.g. CUSTOMER_LOCKED. */
  rejigCode: string | null;
  /** Rejig's staging id — NOT an account id; never write to customers.rejig_user_id. */
  rejigCustomerId: string | null;
  message: string | null;
  /** Response body, truncated. Never contains the API key. */
  response: unknown;
  durationMs: number;
};

/** Whether this environment can be synced right now (URL known + key present). */
export function isRejigEnvConfigured(env: RejigEnv): boolean {
  return ENDPOINTS[env] !== null && !!process.env[KEY_VARS[env]];
}

type RejigBody = {
  success?: boolean;
  message?: string;
  code?: string;
  error?: { code?: string; message?: string } | string;
  data?: { customer_id?: string; outcome?: string };
};

function codeOf(body: RejigBody | null): string | null {
  if (!body) return null;
  if (typeof body.code === 'string') return body.code;
  if (body.error && typeof body.error === 'object' && typeof body.error.code === 'string') {
    return body.error.code;
  }
  return null;
}

function classify(status: number, body: RejigBody | null): RejigSyncOutcome {
  if (status >= 200 && status < 300) {
    return body?.data?.outcome === 'updated' ? 'updated' : 'created';
  }
  const code = codeOf(body);
  if (status === 409 && code === 'CUSTOMER_LOCKED') return 'locked';
  if (status === 409 && code === 'DOMAIN_ALREADY_EXISTS') return 'domain_exists';
  if (status === 400) return 'validation_error';
  if (status === 401 || status === 403) return 'auth_error';
  return 'http_error';
}

/**
 * POST one customer to Rejig. Never throws for HTTP or network failures — the
 * caller always gets a result it can log. Throws only when the environment
 * isn't configured, which the caller should have checked.
 */
export async function postCustomerToRejig(
  env: RejigEnv,
  payload: RejigCustomerPayload,
): Promise<RejigSyncResult> {
  const url = ENDPOINTS[env];
  const apiKey = process.env[KEY_VARS[env]];
  if (!url || !apiKey) {
    throw new Error(`Rejig ${env} is not configured (endpoint or ${KEY_VARS[env]} missing).`);
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Service-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      outcome: 'network_error',
      ok: false,
      httpStatus: null,
      rejigCode: null,
      rejigCustomerId: null,
      message: err instanceof Error ? err.message : String(err),
      response: null,
      durationMs: Date.now() - started,
    };
  }

  const text = await res.text().catch(() => '');
  let body: RejigBody | null = null;
  try {
    body = text ? (JSON.parse(text) as RejigBody) : null;
  } catch {
    body = null;
  }
  const outcome = classify(res.status, body);
  const errorMessage =
    body && typeof body.error === 'object' ? body.error.message : typeof body?.error === 'string' ? body.error : undefined;

  return {
    outcome,
    ok: outcome === 'created' || outcome === 'updated',
    httpStatus: res.status,
    rejigCode: codeOf(body),
    rejigCustomerId: body?.data?.customer_id ?? null,
    message: body?.message ?? errorMessage ?? (body ? null : text.slice(0, 300) || null),
    response: body ?? (text ? text.slice(0, MAX_LOGGED_BODY) : null),
    durationMs: Date.now() - started,
  };
}
