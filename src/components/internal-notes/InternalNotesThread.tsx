import type { InternalNote, InternalNoteAttachment } from '@/types';

/** Compact: collapsed to the latest N, with a <details> reveal for the rest.
 *  Full: every note rendered. */
type Mode = 'compact' | 'full';

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isImage(att: InternalNoteAttachment): boolean {
  return att.contentType?.startsWith('image/') ?? false;
}

function NoteRow({ note }: { note: InternalNote }) {
  const images = note.attachments.filter(isImage);
  const others = note.attachments.filter((a) => !isImage(a));
  return (
    <div className="rounded-lg border border-[#E0DEE4] bg-white p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#6C4AB6]/15 text-[#6C4AB6] text-[10px] font-semibold">
          {(note.authorName ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="font-medium text-[#1B2E35]">{note.authorName ?? 'Unknown'}</span>
        <span className="text-[#1B2E35]/40">· {relTime(note.createdAt)}</span>
      </div>
      {note.body && (
        <p className="text-sm text-[#1B2E35] whitespace-pre-wrap break-words">{note.body}</p>
      )}
      {images.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {images.map((a, i) => (
            <a
              key={`img-${i}`}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-md overflow-hidden border border-[#E0DEE4] bg-[#F7F4EB] aspect-square"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={a.url}
                alt={a.filename ?? `Attachment ${i + 1}`}
                className="w-full h-full object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="space-y-1">
          {others.map((a, i) => (
            <li key={`f-${i}`}>
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#6C4AB6] hover:underline"
              >
                📎 {a.filename ?? `File ${i + 1}`}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function InternalNotesThread({
  notes,
  mode = 'full',
  collapsedLimit = 3,
}: {
  notes: InternalNote[];
  mode?: Mode;
  collapsedLimit?: number;
}) {
  if (notes.length === 0) {
    return mode === 'full' ? (
      <p className="text-sm text-[#1B2E35]/40 italic">
        No internal notes yet.
      </p>
    ) : null;
  }

  if (mode === 'full') {
    return (
      <div className="space-y-2">
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} />
        ))}
      </div>
    );
  }

  // Compact: show the latest N inline, fold the rest behind <details>.
  const head = notes.slice(0, collapsedLimit);
  const tail = notes.slice(collapsedLimit);
  return (
    <div className="space-y-2">
      {head.map((n) => (
        <NoteRow key={n.id} note={n} />
      ))}
      {tail.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-[#6C4AB6] hover:underline list-none">
            <span className="group-open:hidden">Show {tail.length} earlier note{tail.length === 1 ? '' : 's'}</span>
            <span className="hidden group-open:inline">Hide earlier notes</span>
          </summary>
          <div className="mt-2 space-y-2">
            {tail.map((n) => (
              <NoteRow key={n.id} note={n} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
