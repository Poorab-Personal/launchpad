/**
 * Book-filter cookie helpers (parser + cookie name).
 * Lives outside `actions.ts` because `'use server'` modules can only export
 * async functions.
 */

export const BOOK_FILTER_COOKIE = 'lp_csm_book_filter';

/**
 * Cookie value formats:
 *   ""              → default ("my")
 *   "my"            → my book (default)
 *   "unassigned"    → unassigned active customers
 *   "all"           → all customers
 *   "member:recXXX" → another CSM's book
 */
export type BookFilter =
  | { kind: 'my' }
  | { kind: 'unassigned' }
  | { kind: 'all' }
  | { kind: 'member'; memberId: string };

export function parseBookFilter(value: string | undefined): BookFilter {
  if (!value || value === 'my') return { kind: 'my' };
  if (value === 'unassigned') return { kind: 'unassigned' };
  if (value === 'all') return { kind: 'all' };
  if (value.startsWith('member:')) {
    const memberId = value.slice('member:'.length);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId)) {
      return { kind: 'member', memberId };
    }
  }
  return { kind: 'my' };
}
