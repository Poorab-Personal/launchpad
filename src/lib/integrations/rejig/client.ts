/**
 * Rejig API client — fetches the customer-account snapshot used by the BI
 * ingestion pipeline. API-only per Pass 2.7 §29.1 (no file-mode read path).
 *
 * Auth via X-Service-API-Key header. Env: REJIG_API_KEY only.
 * The endpoint URL is hardcoded — Rejig is a single fixed third-party
 * SaaS (no staging API, nothing to override), and making it env-driven
 * once led to a doubled-path 404 when someone pasted the full endpoint
 * into the env var. If Rejig ever changes their base URL, that warrants
 * a code change, not a silent env swap.
 *
 * Pass 2.7 §29.2: cadence is weekly (snapshot fetched Monday 10 UTC, BI
 * cron runs Monday 11 UTC). This client does NOT cache — the importer
 * controls cadence externally.
 */

const ACCOUNTS_URL = 'https://api.rejig.ai/dashboard/admin/account-list';

export type RejigContentTypeBreakdown = Record<string, number>;

export type RejigPostMetrics = {
  total_published: number;
  video_posts: number;
  image_posts: number;
  content_type_breakdown: RejigContentTypeBreakdown;
  days_since_last_post: number | null;
};

export type RejigAccount = {
  _id: string;                                  // Mongo ID — authoritative rejigUserId
  account_name: string;
  email: string;
  business_name: string;
  display_business_name: string;
  domain_url: string;
  plan_expiry_date: string;                      // ISO
  days_until_expiry: number;
  subscription_status: 'active' | 'trialing' | 'canceled' | 'deactivated' | '' | string;
  plan_key: string | null;
  stripe_subscription_id: string | null;
  is_manual: boolean;
  last_login: string | null;                     // ISO or null
  listing_count: number;
  post_metrics: RejigPostMetrics;
};

export type RejigAccountsResponse = {
  status: boolean;
  code: number;
  data: RejigAccount[];
  message?: string;
  error?: unknown;
};

/**
 * Fetch the full account-list snapshot from the Rejig API.
 *
 * No retry / backoff in this layer — caller decides (Phase 5 importer
 * runs ad-hoc; Phase 9 cron wraps in its own retry logic if needed).
 *
 * Throws on:
 *   - REJIG_API_KEY missing
 *   - non-2xx HTTP response (includes status code in message)
 *   - response body missing `data` array
 */
export async function fetchAccountsSnapshot(): Promise<RejigAccount[]> {
  const apiKey = process.env.REJIG_API_KEY;
  if (!apiKey) {
    throw new Error(
      'REJIG_API_KEY is not set. Required for Rejig API. Set in .env.local for local dev, and in Vercel Production env for cron deployment.',
    );
  }
  const res = await fetch(ACCOUNTS_URL, {
    method: 'GET',
    headers: {
      'X-Service-API-Key': apiKey,
      'Accept': 'application/json',
    },
    // Important: don't cache — we always want fresh
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Rejig API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  const parsed = (await res.json()) as RejigAccountsResponse;
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error('Rejig API response missing `data` array');
  }
  return parsed.data;
}
