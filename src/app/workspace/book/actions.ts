'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/dal';
import { BOOK_FILTER_COOKIE, parseBookFilter, type BookFilter } from './filter';

/** Read current filter from the cookie store. */
export async function readBookFilter(): Promise<BookFilter> {
  const store = await cookies();
  return parseBookFilter(store.get(BOOK_FILTER_COOKIE)?.value);
}

/** Server action invoked by `BookFilter` <select>. */
export async function setBookFilter(formData: FormData) {
  await requireSession();
  const raw = formData.get('filter');
  const value = typeof raw === 'string' ? raw : 'my';
  const parsed = parseBookFilter(value);

  // Re-serialize to canonical form before writing
  let canonical: string;
  if (parsed.kind === 'my') canonical = 'my';
  else if (parsed.kind === 'unassigned') canonical = 'unassigned';
  else if (parsed.kind === 'all') canonical = 'all';
  else canonical = `member:${parsed.memberId}`;

  const store = await cookies();
  if (canonical === 'my') {
    store.delete(BOOK_FILTER_COOKIE);
  } else {
    store.set(BOOK_FILTER_COOKIE, canonical, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
  }

  revalidatePath('/workspace/book');
  redirect('/workspace/book');
}
