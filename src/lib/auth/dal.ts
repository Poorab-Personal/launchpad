import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { readSessionCookie, type SessionPayload } from './session';
import { readViewAs } from './view-as';
import { getTeamMemberById } from '@/lib/db';

// Sessions issued pre-Postgres-migration stored Airtable rec IDs as
// memberId (`recXXXXXXXXXXXXX`). Post-migration, memberId is a Postgres
// UUID. Reject old-format sessions so stale cookies fall back to /signin
// instead of throwing "invalid input syntax for type uuid" downstream.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verify the current request has a valid session. Redirects to /signin if not.
 * Memoized per-request via React cache().
 */
export const requireSession = cache(async (): Promise<SessionPayload> => {
  const session = await readSessionCookie();
  if (!session) {
    redirect('/signin');
  }
  if (!UUID_RE.test(session.memberId)) {
    // Stale session from pre-migration era; force re-signin
    redirect('/signin');
  }
  return session;
});

/**
 * Get current session without redirecting. Returns null if no session.
 */
export const getSession = cache(async (): Promise<SessionPayload | null> => {
  return readSessionCookie();
});

/**
 * Require a specific role. 403 redirect if mismatch.
 * "Admin" role passes any role check.
 */
export async function requireRole(allowedRoles: string[]): Promise<SessionPayload> {
  const session = await requireSession();
  if (session.role === 'Admin') return session;
  if (!allowedRoles.includes(session.role)) {
    redirect('/workspace?error=forbidden');
  }
  return session;
}

/**
 * Writers to /admin. Anyone with session.role === 'Admin' gets write
 * access to mutate customer records (create, delete, billing changes).
 * Today (2026-05-22) that's Poorab + Mansi + Jigar.
 *
 * History: was hardcoded to poorab@rejig.ai-only, widened to all Admins
 * once Mansi + Jigar were promoted and needed to add customers.
 */
export function isAdminWriter(session: SessionPayload): boolean {
  return session.role === 'Admin';
}

/**
 * Effective writer status — also honors the workspace view-as override.
 * When the writer (poorab@rejig.ai) is impersonating any role or member
 * via /workspace's RoleSwitcher, treat them as read-only so /admin renders
 * exactly what that role would see and mutations 403. Lets us test the
 * read-only experience without a second account.
 *
 * Clear view-as in /workspace → writer mode restored.
 */
export async function isEffectiveAdminWriter(
  session: SessionPayload,
): Promise<boolean> {
  if (!isAdminWriter(session)) return false;
  const view = await readViewAs();
  return view.kind === 'none';
}

/**
 * Gate /admin mutations (server actions + write API routes). Throws on
 * non-writers so server actions surface the rejection rather than silently
 * succeeding with no DB change. Respects view-as.
 */
export async function requireAdminWrite(): Promise<SessionPayload> {
  const session = await requireSession();
  if (!(await isEffectiveAdminWriter(session))) {
    throw new Error('Forbidden: admin write access required');
  }
  return session;
}

export type EffectiveContext = {
  /** Role used for routing & UI flow decisions */
  role: string;
  /** Member ID used for "my tasks" filtering (impersonation when admin views as a member) */
  memberId: string;
  /** Whether an Admin override is active */
  isViewAs: boolean;
  /** Display label, e.g. "Kaushal (Designer)" or "Designer" */
  label: string;
};

/**
 * Returns the effective role + memberId for rendering the workspace.
 * - Non-admins always see their own role and memberId.
 * - Admin without override: role='Admin', memberId=their own (broad/overview mode).
 * - Admin viewing as role: that role, memberId=their own (broad role view).
 * - Admin impersonating member: that member's role and memberId.
 */
export async function getEffectiveContext(
  session: SessionPayload,
): Promise<EffectiveContext> {
  if (session.role !== 'Admin') {
    return {
      role: session.role,
      memberId: session.memberId,
      isViewAs: false,
      label: session.role,
    };
  }
  const view = await readViewAs();
  if (view.kind === 'role') {
    return {
      role: view.role,
      memberId: session.memberId,
      isViewAs: true,
      label: view.role,
    };
  }
  if (view.kind === 'member') {
    const member = await getTeamMemberById(view.memberId);
    if (!member) {
      // Stale/deleted — fall through to default
      return {
        role: 'Admin',
        memberId: session.memberId,
        isViewAs: false,
        label: 'Admin',
      };
    }
    return {
      role: member.role,
      memberId: member.id,
      isViewAs: true,
      label: `${member.name.split(' ')[0]} (${member.role})`,
    };
  }
  return {
    role: 'Admin',
    memberId: session.memberId,
    isViewAs: false,
    label: 'Admin',
  };
}
