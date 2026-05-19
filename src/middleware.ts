import { NextResponse } from 'next/server';

// All /admin gating now lives in the route layout via requireSession() +
// requireAdminWrite() from src/lib/auth/dal.ts (same magic-link session as
// /workspace, restricted to @rejig.ai emails). No middleware checks needed.
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
