import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { readSessionCookie, type SessionPayload } from './session';
import { readViewAs } from './view-as';
import { getTeamMemberById } from '@/lib/airtable';

/**
 * Verify the current request has a valid session. Redirects to /signin if not.
 * Memoized per-request via React cache().
 */
export const requireSession = cache(async (): Promise<SessionPayload> => {
  const session = await readSessionCookie();
  if (!session) {
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
