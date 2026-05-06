import 'server-only';
import { cookies } from 'next/headers';

const VIEW_AS_COOKIE = 'lp_view_as';
const ALLOWED_ROLES = ['Designer', 'Senior Designer', 'CSM', 'Account Creator', 'Onboarding Ops'] as const;

export type ViewAsRole = (typeof ALLOWED_ROLES)[number];

/**
 * Cookie value formats:
 *   ""              → clear (no override, view as Admin default)
 *   "role:Designer" → view UI for that role generically
 *   "member:recXXX" → impersonate a specific Team Member (uses their role)
 */
export type ViewAsContext =
  | { kind: 'none' }
  | { kind: 'role'; role: ViewAsRole }
  | { kind: 'member'; memberId: string };

function parse(value: string | undefined): ViewAsContext {
  if (!value) return { kind: 'none' };
  if (value.startsWith('role:')) {
    const role = value.slice('role:'.length);
    if ((ALLOWED_ROLES as readonly string[]).includes(role)) {
      return { kind: 'role', role: role as ViewAsRole };
    }
    return { kind: 'none' };
  }
  if (value.startsWith('member:')) {
    const memberId = value.slice('member:'.length);
    if (/^rec[a-zA-Z0-9]+$/.test(memberId)) {
      return { kind: 'member', memberId };
    }
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

export async function readViewAs(): Promise<ViewAsContext> {
  const store = await cookies();
  return parse(store.get(VIEW_AS_COOKIE)?.value);
}

export async function setViewAsRaw(rawValue: string) {
  const store = await cookies();
  const parsed = parse(rawValue);
  if (parsed.kind === 'none') {
    store.delete(VIEW_AS_COOKIE);
    return;
  }
  store.set(VIEW_AS_COOKIE, rawValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24, // 1 day
  });
}

export const VIEW_AS_ROLE_OPTIONS = ALLOWED_ROLES;
