'use server';

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
