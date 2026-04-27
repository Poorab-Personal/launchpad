import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  // Only protect /admin routes
  if (!request.nextUrl.pathname.startsWith('/admin')) {
    return NextResponse.next();
  }

  // Skip if no ADMIN_PASSWORD set (local dev)
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.next();
  }

  // Allow the login page itself
  if (request.nextUrl.pathname === '/admin/login') {
    return NextResponse.next();
  }

  // Check for auth cookie
  const authCookie = request.cookies.get('admin_auth');
  if (authCookie?.value === '1') {
    return NextResponse.next();
  }

  // Redirect to login
  return NextResponse.redirect(new URL('/admin/login', request.url));
}

export const config = {
  matcher: ['/admin/:path*'],
};
