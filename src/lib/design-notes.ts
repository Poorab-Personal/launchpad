/**
 * Helpers over customer.designNotes — the round-by-round designer↔customer
 * note trail. Append-only; latest-by-author wins for the current-round read.
 */
import type { Customer, DesignNote } from '@/types';

/** Latest note authored by `who`, or null if the customer hasn't received
 *  (or sent) one yet. Used for the "FROM YOUR DESIGNER" callout in the
 *  customer portal and the "Customer Feedback" callout in workspace. */
export function latestNoteFrom(
  customer: Pick<Customer, 'designNotes'>,
  who: 'designer' | 'customer',
): DesignNote | null {
  const notes = customer.designNotes ?? [];
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i].from === who) return notes[i];
  }
  return null;
}

/** Build a new note entry. Call site appends via `[...customer.designNotes, makeNote(...)]`. */
export function makeNote(
  from: 'designer' | 'customer',
  note: string,
  uploadTask: string | null,
): DesignNote {
  return {
    from,
    note,
    uploadTask,
    at: new Date().toISOString(),
  };
}
