import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'lp_session';

/**
 * Legacy redirects served on `onboarding.rejig.ai` after the Cloudflare
 * Worker is retired. These paths were previously handled by the
 * `rejig-onboarding` Worker; once `onboarding.rejig.ai` flips to Vercel
 * (see docs/plans/onboarding-domain-cutover.md), this proxy takes over.
 *
 * 302 (not 301) so a future edit to remove an entry takes effect for cached
 * clients immediately. Query strings drop on redirect (matches Worker today;
 * none of the Apps Script targets read query params).
 */
const LEGACY_REDIRECTS: Record<string, string> = {
  '/keyes':
    'https://script.google.com/macros/s/AKfycbzhWpg7ugtSXpsjtXuo97SvrGeQNFFcmlm-UI5Oc02ToI6e3I2au9AhE5rc8KQqHtNwgA/exec',
  '/b&w':
    'https://script.google.com/macros/s/AKfycbxsYY48xaZk3No8lKQ3pXo9cqTV6x4NaLeCQQUrC2-exHK9hsgcfwoB3-3cir9HhSwm/exec',
  '/': 'https://rejig.ai',
};

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // ── Legacy-Worker redirects ─────────────────────────────────────────────
  // These are exact-match-only (no prefix matching) and run before the
  // /workspace auth check so the proxy stays single-purpose per request.
  const target = LEGACY_REDIRECTS[path];
  if (target) {
    return NextResponse.redirect(target, 302);
  }

  // ── /workspace cookie gate ──────────────────────────────────────────────
  if (!path.startsWith('/workspace')) {
    return NextResponse.next();
  }

  // Optimistic check only — does the cookie exist?
  // Full JWT verification happens in server components / route handlers
  // via the DAL (requireSession). Edge runtime can't import jose easily.
  const hasSession = request.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/signin';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // The legacy redirects join the /workspace gate via additional matchers.
  // `/b&w` requires single-quote escaping in shell tests but Next routes the
  // literal path fine.
  matcher: ['/workspace/:path*', '/keyes', '/b&w', '/'],
};
