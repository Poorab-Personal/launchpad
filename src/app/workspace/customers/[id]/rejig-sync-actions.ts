'use server';

import { revalidatePath } from 'next/cache';
import { hasLiveRole, requireSession } from '@/lib/auth/dal';
import { readViewAs } from '@/lib/auth/view-as';
import { syncCustomerToRejig, type SyncResult } from '@/lib/rejig-sync/sync';
import type { RejigEnv } from '@/lib/integrations/rejig/onboarding';

const SYNC_ROLES = ['Account Creator'] as const;

/**
 * Account Creator (or Admin) pushes a customer to Rejig. Live role check
 * (not the sign-in snapshot). Prod has two extra locks: never while viewing
 * as someone else, and only from the production deployment — Preview builds
 * share the prod DB but must never reach Rejig prod.
 */
export async function syncToRejigAction(args: {
  customerId: string;
  env: RejigEnv;
  firstName: string;
  lastName: string;
  isTeam: boolean;
}): Promise<SyncResult> {
  const session = await requireSession();
  if (args.env !== 'dev' && args.env !== 'prod') {
    return { ok: false, outcome: 'preflight', message: 'Unknown environment.' };
  }
  if (!(await hasLiveRole(session, SYNC_ROLES))) {
    return { ok: false, outcome: 'preflight', message: 'Only account creators can sync to Rejig.' };
  }
  if (args.env === 'prod') {
    if ((await readViewAs()).kind !== 'none') {
      return { ok: false, outcome: 'preflight', message: 'Switch off "View as" before syncing to Rejig Prod.' };
    }
    if (process.env.VERCEL_ENV !== 'production') {
      return { ok: false, outcome: 'not_configured', message: 'Rejig Prod can only be synced from the live site.' };
    }
  }

  const result = await syncCustomerToRejig({
    customerId: args.customerId,
    env: args.env,
    name: { firstName: String(args.firstName ?? ''), lastName: String(args.lastName ?? '') },
    isTeam: args.isTeam === true,
    actorId: session.memberId,
  });

  revalidatePath(`/workspace/customers/${args.customerId}`);
  return result;
}
