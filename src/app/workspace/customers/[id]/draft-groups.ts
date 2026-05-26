import type { AirtableAttachment } from '@/types';

export type DraftGroup = {
  /** Display header — "Revise Design (Round 1)" or "Untagged uploads" for legacy entries. */
  label: string;
  /** ISO of this group's newest file. `null` for the untagged legacy group. */
  newestAt: string | null;
  drafts: AirtableAttachment[];
};

/**
 * Group drafts by `uploadTask` (which round produced them), newest-first
 * inside each group, with the most-recent group on top. Entries without
 * `uploadTask` (pre-2026-05-26 uploads) collapse into a single "Untagged"
 * bucket that sorts last.
 *
 * Used by both the Drafts panel on the customer detail page and the
 * SendToCustomerAction modal so the designer always sees the same shape.
 */
export function groupDrafts(drafts: AirtableAttachment[]): DraftGroup[] {
  const byTask = new Map<string, AirtableAttachment[]>();
  for (const d of drafts) {
    const key = d.uploadTask ?? '__untagged__';
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key)!.push(d);
  }
  const groups: DraftGroup[] = [];
  for (const [key, ds] of byTask) {
    const sorted = [...ds].sort((a, b) =>
      (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''),
    );
    groups.push({
      label: key === '__untagged__' ? 'Untagged uploads' : key,
      newestAt: sorted[0]?.uploadedAt ?? null,
      drafts: sorted,
    });
  }
  // Untagged group sorts last; tagged groups newest-first by their newest file.
  groups.sort((a, b) => {
    if (!a.newestAt && b.newestAt) return 1;
    if (a.newestAt && !b.newestAt) return -1;
    if (!a.newestAt && !b.newestAt) return 0;
    return (b.newestAt ?? '').localeCompare(a.newestAt ?? '');
  });
  return groups;
}

/**
 * Short "May 26, 06:09" stamp. Returns empty string for missing input so
 * callers can render `{stamp && <span>...</span>}` cleanly.
 */
export function formatGroupStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
