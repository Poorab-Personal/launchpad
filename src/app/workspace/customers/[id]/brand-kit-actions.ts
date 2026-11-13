'use server';

import { revalidatePath } from 'next/cache';
import { hasLiveRole, requireSession } from '@/lib/auth/dal';
import { createEvent, getCustomerById, saveBrandKitFields, saveBrandKitLogo } from '@/lib/db';
import {
  BRAND_KIT_EDITOR_ROLES,
  LOGO_SLOTS,
  sanitizeBrandKitFields,
  type LogoSlot,
} from '@/lib/brand-kit';
import type { AirtableAttachment, ProductTier } from '@/types';

const PRODUCT_TIERS: readonly ProductTier[] = ['Premium', 'Luxury'];

type Result = { ok: true } | { ok: false; error: string };

async function authorize(customerId: string): Promise<{ memberId: string } | { error: string }> {
  const session = await requireSession();
  if (!(await hasLiveRole(session, BRAND_KIT_EDITOR_ROLES))) {
    return { error: 'Only designers and account creators can edit the brand kit.' };
  }
  if (!(await getCustomerById(customerId))) {
    return { error: 'Customer not found.' };
  }
  return { memberId: session.memberId };
}

/**
 * Save the designer's brand-kit form (everything except logos) plus account
 * type, which lives on customers.product_tier. Partial kits are allowed —
 * completeness is checked at sync time (and, from P4, at Create Designs).
 */
export async function saveBrandKitAction(args: {
  customerId: string;
  fields: unknown;
  accountType: string | null;
}): Promise<Result> {
  const auth = await authorize(args.customerId);
  if ('error' in auth) return { ok: false, error: auth.error };

  const accountType = PRODUCT_TIERS.includes(args.accountType as ProductTier)
    ? (args.accountType as ProductTier)
    : null;

  await saveBrandKitFields(
    args.customerId,
    sanitizeBrandKitFields(args.fields),
    accountType,
    auth.memberId,
  );

  revalidatePath(`/workspace/customers/${args.customerId}`);
  return { ok: true };
}

/** Set or clear one logo slot after the browser has uploaded it to Blob. */
export async function saveBrandKitLogoAction(args: {
  customerId: string;
  slot: LogoSlot;
  attachment: { url: string; filename: string } | null;
}): Promise<Result> {
  const auth = await authorize(args.customerId);
  if ('error' in auth) return { ok: false, error: auth.error };
  if (!(LOGO_SLOTS as readonly string[]).includes(args.slot)) {
    return { ok: false, error: 'Unknown logo slot.' };
  }

  const attachment: AirtableAttachment | null = args.attachment
    ? {
        url: args.attachment.url,
        filename: args.attachment.filename.slice(0, 200),
        uploadedAt: new Date().toISOString(),
      }
    : null;

  try {
    await saveBrandKitLogo(args.customerId, args.slot, attachment, auth.memberId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not save logo.' };
  }

  try {
    await createEvent(
      args.customerId,
      'Brand Kit Updated',
      'Team Member',
      attachment
        ? `Brand kit ${args.slot} logo uploaded (${attachment.filename}).`
        : `Brand kit ${args.slot} logo removed.`,
      undefined,
      auth.memberId,
    );
  } catch (err) {
    console.warn('Event log failed (non-fatal):', err);
  }

  revalidatePath(`/workspace/customers/${args.customerId}`);
  return { ok: true };
}
