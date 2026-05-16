'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { customers } from '@/db/schema/customers';
import { requireRole } from '@/lib/auth/dal';

/**
 * Hard-delete a customer. Cascades via FK constraints to:
 *   - tasks + task_dependencies
 *   - calls
 *   - events
 *   - customer_subscriptions
 *
 * roster.customer_id sets to null (intentional — roster row outlives the
 * customer's onboarding lifecycle and may be re-linked later).
 *
 * Does NOT touch HubSpot or Stripe. If the customer has live HubSpot Ticket
 * or Stripe Subscription, those continue to exist; manually clean up there
 * if needed.
 *
 * Admin only.
 */
export async function deleteCustomerAction(formData: FormData): Promise<void> {
  await requireRole(['Admin']);

  const id = formData.get('id');
  if (typeof id !== 'string' || !id) {
    throw new Error('Missing customer id');
  }

  const deleted = await db
    .delete(customers)
    .where(eq(customers.id, id))
    .returning({ id: customers.id, name: customers.name });

  if (deleted.length === 0) {
    throw new Error(`Customer ${id} not found`);
  }

  console.log(`[admin] deleted customer ${id} (${deleted[0].name})`);

  redirect('/admin');
}

/**
 * Update billing_relationship for a customer. Admin only.
 * Future: also push to HS Contact's rejig_billing_relationship property.
 */
const BILLING_VALUES = new Set(['paying', 'comped', 'internal_demo']);

export async function updateBillingRelationshipAction(formData: FormData): Promise<void> {
  await requireRole(['Admin']);

  const id = formData.get('id');
  const value = formData.get('billing_relationship');
  if (typeof id !== 'string' || !id) throw new Error('Missing customer id');
  if (typeof value !== 'string' || !BILLING_VALUES.has(value)) {
    throw new Error(`Invalid billing_relationship: ${value}`);
  }

  await db
    .update(customers)
    .set({ billingRelationship: value as 'paying' | 'comped' | 'internal_demo' })
    .where(eq(customers.id, id));

  console.log(`[admin] customer ${id} billing_relationship → ${value}`);
  revalidatePath(`/admin/${id}`);
}
