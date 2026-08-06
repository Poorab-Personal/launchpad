import type { DesignNote, InternalNoteAttachment } from '@/types';

/** Who's looking — controls the author labels ("You" vs the real name). */
type Viewer = 'customer' | 'team';

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

function authorLabel(note: DesignNote, viewer: Viewer): string {
  if (viewer === 'customer') {
    return note.from === 'customer' ? 'You' : note.authorName ?? 'Your designer';
  }
  // team viewer
  return note.from === 'designer'
    ? note.authorName ?? 'Design team'
    : note.authorName ?? 'Customer';
}

function NoteRow({ note, viewer }: { note: DesignNote; viewer: Viewer }) {
  const attachments = note.attachments ?? [];
  const images = attachments.filter(isImage);
  const others = attachments.filter((a) => !isImage(a));
  const isDesigner = note.from === 'designer';
  // Tint by side: designer = purple, customer = green.
  const tint = isDesigner
    ? 'border-[#6C4AB6]/25 bg-[#6C4AB6]/5'
    : 'border-[#05C68E]/25 bg-[#05C68E]/5';
  const avatarTint = isDesigner
    ? 'bg-[#6C4AB6]/15 text-[#6C4AB6]'
    : 'bg-[#05C68E]/15 text-[#04946A]';
  const label = authorLabel(note, viewer);

  return (
    <div className={`rounded-lg border ${tint} p-3 space-y-2`}>
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ${avatarTint}`}
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
        <span className="font-medium text-[#1B2E35]">{label}</span>
        <span className="text-[#1B2E35]/40">· {relTime(note.at)}</span>
      </div>
      {note.note && (
        <p className="text-sm text-[#1B2E35] whitespace-pre-wrap break-words">{note.note}</p>
      )}
      {images.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {images.map((a, i) => (
            <a
              key={`img-${i}`}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-md overflow-hidden border border-[#E0DEE4] bg-white aspect-square"
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

/**
 * The full designer↔customer conversation, oldest → newest. Renders the
 * customers.designNotes trail (round-boundary feedback + free-form messages
 * interleaved). Returns null when empty.
 */
export default function DesignThread({
  notes,
  viewer,
}: {
  notes: DesignNote[];
  viewer: Viewer;
}) {
  if (!notes || notes.length === 0) return null;
  return (
    <div className="space-y-2">
      {notes.map((n, i) => (
        <NoteRow key={`${n.at}-${i}`} note={n} viewer={viewer} />
      ))}
    </div>
  );
}
