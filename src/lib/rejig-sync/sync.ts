import {
  createEvent,
  getBrokerageById,
  getCustomerById,
  recordRejigSyncAttempt,
  updateCustomerFields,
} from '@/lib/db';
import {
  isRejigEnvConfigured,
  postCustomerToRejig,
  type RejigEnv,
  type RejigSyncOutcome,
} from '@/lib/integrations/rejig/onboarding';
import { buildRejigPayload, syncPreflight, type AgentName } from './payload';

/**
 * Push one customer to Rejig's onboarding staging API. Rejig holds it until
 * the Account Creator finishes it in "Create Account (New)". The caller has
 * already checked the actor's role (and, for prod, the extra prod locks).
 * Plan: docs/plans/rejig-account-sync.md.
 *
 * Every attempt that reaches Rejig is logged to rejig_sync_attempts, whatever
 * the result. Does NOT complete any task — Mark Account Created stays manual.
 */

export type SyncResult =
  | { ok: true; outcome: RejigSyncOutcome; message: string }
  | { ok: false; outcome: RejigSyncOutcome | 'preflight' | 'not_configured'; message: string };

const ENV_LABEL: Record<RejigEnv, string> = { dev: 'Rejig Dev', prod: 'Rejig Prod' };

function messageFor(outcome: RejigSyncOutcome, env: RejigEnv, website: string, raw: string | null): string {
  switch (outcome) {
    case 'created':
    case 'updated':
      return `Sent to ${ENV_LABEL[env]}. Open Create Account (New) in Rejig to finish.`;
    case 'locked':
      return 'This account was already created in Rejig. Make changes in Rejig.';
    case 'domain_exists':
      return `Rejig already has an account for ${website}.`;
    case 'validation_error':
      return raw ? `Rejig rejected the data: ${raw}` : 'Rejig rejected the data.';
    case 'auth_error':
      return 'Rejig rejected the API key. Tell an admin.';
    case 'network_error':
      return `Couldn't reach ${ENV_LABEL[env]}. Try again in a minute.`;
    default:
      return raw ? `Rejig returned an error: ${raw}` : 'Rejig returned an error.';
  }
}

export async function syncCustomerToRejig(args: {
  customerId: string;
  env: RejigEnv;
  name: AgentName;
  isTeam: boolean;
  actorId: string;
}): Promise<SyncResult> {
  if (!isRejigEnvConfigured(args.env)) {
    return { ok: false, outcome: 'not_configured', message: `${ENV_LABEL[args.env]} isn't set up yet.` };
  }

  const customer = await getCustomerById(args.customerId);
  if (!customer) return { ok: false, outcome: 'preflight', message: 'Customer not found.' };
  const brokerage = customer.brokerage[0] ? await getBrokerageById(customer.brokerage[0]) : null;

  const name = { firstName: args.name.firstName.trim(), lastName: args.name.lastName.trim() };
  const input = {
    customer,
    brokerage: brokerage
      ? { name: brokerage.name, shortName: brokerage.shortName, rejigBrokerId: brokerage.rejigBrokerId }
      : null,
    name,
    isTeam: args.isTeam,
    brandKit: customer.brandKit,
  };
  const missing = syncPreflight(input);
  if (missing.length > 0) {
    return { ok: false, outcome: 'preflight', message: `Missing: ${missing.join(', ')}.` };
  }

  // Remember the confirmed names and voice so a re-sync doesn't need them redone.
  if (
    name.firstName !== customer.firstName ||
    name.lastName !== customer.lastName ||
    args.isTeam !== customer.isTeam
  ) {
    await updateCustomerFields(customer.id, {
      firstName: name.firstName,
      lastName: name.lastName,
      isTeam: args.isTeam,
    });
  }

  const payload = buildRejigPayload(input);
  const result = await postCustomerToRejig(args.env, payload);

  await recordRejigSyncAttempt({
    customerId: customer.id,
    environment: args.env,
    outcome: result.outcome,
    httpStatus: result.httpStatus,
    rejigCode: result.rejigCode,
    rejigCustomerId: result.rejigCustomerId,
    payload,
    response: result.response as object | null,
    durationMs: result.durationMs,
    actorTeamMemberId: args.actorId,
  });

  try {
    await createEvent(
      customer.id,
      'Rejig Sync',
      'Team Member',
      `Synced to ${ENV_LABEL[args.env]}: ${result.outcome}` +
        (result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''),
      undefined,
      args.actorId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  const message = messageFor(result.outcome, args.env, payload.website, result.message);
  return result.ok
    ? { ok: true, outcome: result.outcome, message }
    : { ok: false, outcome: result.outcome, message };
}
