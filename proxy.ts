import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'lp_session';

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

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
  matcher: ['/workspace/:path*'],
};
