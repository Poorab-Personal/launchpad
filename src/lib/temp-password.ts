/**
 * Pattern-based temp password — single source of truth across the system.
 *
 * Rule:
 *   1. Take the last whitespace-separated word from the customer's name.
 *   2. If it's a generational suffix (Jr, Sr, II, III, IV, with optional
 *      "."), use the prior word instead.
 *   3. Strip diacritics (NFD-normalize, drop combining marks).
 *   4. Treat hyphens and all apostrophe variants (', ’, ‘, ʼ, `, ′) as
 *      segment delimiters. Strip any other non-alphanumeric.
 *   5. Per segment: lowercase, then uppercase the first letter (strict
 *      camel). Join segments with no separator.
 *   6. Append `123!`. If total length < 8, extend the digit block until
 *      the password is at least 8 characters (Rejig's minimum).
 *   7. Empty/garbage input falls through to `Welcome123!`.
 *
 * Examples:
 *   "John Smith"       → "Smith123!"
 *   "Christina Day"    → "Day1234!"        (padded to 8)
 *   "Patrick O'Neil"   → "ONeil123!"       (apostrophe is delimiter)
 *   "Mary Jones-Smith" → "JonesSmith123!"  (hyphen is delimiter)
 *   "MARY SMITH"       → "Smith123!"
 *   "John Smith III"   → "Smith123!"       (suffix skipped)
 *   "Maria González"   → "Gonzalez123!"    (diacritic stripped)
 *   ""                 → "Welcome123!"
 *
 * Used in four places — all derive on demand, nothing stored:
 *  1. Account Creator's Send Credentials UI
 *  2. credentials-sent email body
 *  3. Customer portal Sign In task
 *  4. Customer portal post-launch Handy page
 *
 * The Account Creator must use this same value when creating the
 * customer's account in app.rejig.ai. The customer is required to reset
 * on first sign-in to Rejig, so this is genuinely a *temporary*
 * password — divergence after first login is harmless.
 */

const SUFFIX_RE = /^(jr|sr|ii|iii|iv)\.?$/i;
// Hyphen + every apostrophe-like Unicode codepoint we've seen in the wild
// (straight quote, smart quotes, modifier letter apostrophe / Hawaiian
// ʻokina, backtick, prime). Anything else inside a base lastname
// (periods, commas, &, ®, etc.) is stripped in the per-segment cleanup
// below, not split on.
const DELIMITER_RE = /[-'’‘ʼ`′]+/;
const COMBINING_DIACRITIC_RE = /[̀-ͯ]/g;

export function tempPasswordFromName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'Welcome123!';

  const words = trimmed.split(/\s+/);
  let base = words[words.length - 1];
  if (words.length > 1 && SUFFIX_RE.test(base)) {
    base = words[words.length - 2];
  }

  const segments = base
    .normalize('NFD')
    .replace(COMBINING_DIACRITIC_RE, '')
    .split(DELIMITER_RE)
    .map((seg) => seg.replace(/[^A-Za-z0-9]/g, ''))
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase());

  const cleaned = segments.join('');
  if (!cleaned) return 'Welcome123!';

  // 8-char minimum: "BASE" + "123…" + "!". When BASE < 4 chars, extend
  // the digit block. "1234567" supports bases down to length 1.
  const digitCount = Math.max(3, 7 - cleaned.length);
  const digits = '1234567'.slice(0, digitCount);
  return `${cleaned}${digits}!`;
}
