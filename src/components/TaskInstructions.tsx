/**
 * Task instruction text with support for markdown-style links.
 *
 * Instructions live in `workflow_templates.instructions` and were rendered as
 * raw text everywhere, so a URL in them showed up as a naked 60-character
 * string the reader had to select and paste (see the Coach "check the Dropbox
 * folder" design step). This renders `[label](url)` as a real anchor and
 * leaves everything else exactly as before — existing instructions contain no
 * bracket-paren syntax, so nothing else changes appearance.
 *
 * Only http/https URLs become links. Anything else (javascript:, data:, …)
 * renders as plain text — instructions are admin-authored and therefore
 * trusted, but this is cheap and removes the question entirely.
 */
import { Fragment } from 'react';

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function TaskInstructions({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    parts.push(
      <a
        key={key++}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[#6C4AB6] underline underline-offset-2 hover:text-[#6C4AB6]/80"
      >
        {match[1]}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }

  return <p className={className}>{parts}</p>;
}
