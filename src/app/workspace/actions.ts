'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/dal';
import { setViewAsRaw } from '@/lib/auth/view-as';

/**
 * Admin-only: set or clear the view-as override.
 * The form value is the raw cookie format (e.g. "role:Designer", "member:recXXX", "").
 */
export async function setViewAsRole(formData: FormData) {
  const session = await requireSession();
  if (session.role !== 'Admin') {
    return; // silently ignore — non-admins can't switch
  }

  const value = formData.get('role');
  await setViewAsRaw(typeof value === 'string' ? value : '');

  revalidatePath('/workspace', 'layout');
  redirect('/workspace');
}
