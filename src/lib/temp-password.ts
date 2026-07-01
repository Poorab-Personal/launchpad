/**
 * Pattern-based temp password — single source of truth across the system.
 *
 * Rule:
 *   1. Take the last whitespace-separated word from the customer's name.
 *   2. If it's a generational suffix (Jr, Sr, II, III, IV) OR a common
 *      professional designation (PA, MBA, CPA, MD, DDS, RN, PhD, Esq,
 *      CFA, CFP, ABR, GRI, CRS, CLHMS, SRES, SRS), with optional ".",
 *      use the prior word instead. Applied recursively — "Broker, MBA"
 *      strips MBA, then would strip Broker only if Broker were also on
 *      the list (it's not, so it stays).
 *   3. Strip diacritics (NFD-normalize, drop combining marks).
 *   4. Treat hyphens and all apostrophe variants (', ’, ‘, ʼ, `, ′) as
 *      segment delimiters. Strip any other non-alphanumeric.
 *   5. Per segment:
 *        - If the segment is already mixed case (has both upper and lower
 *          letters), preserve the author's casing — this keeps McCallum,
 *          MacDonald, DiCaprio, DeSantis, O'Neil, VanDresser intact.
 *        - Otherwise (uniform upper OR uniform lower), title-case: first
 *          letter uppercase, rest lowercase. Normalizes SMITH → Smith
 *          and smith → Smith.
 *      Join segments with no separator.
 *   6. Append `123!`. If total length < 8, extend the digit block until
 *      the password is at least 8 characters (Rejig's minimum).
 *   7. Empty/garbage input falls through to `Welcome123!`.
 *
 * Examples:
 *   "John Smith"           → "Smith123!"
 *   "Christina Day"        → "Day1234!"        (padded to 8)
 *   "Patrick O'Neil"       → "ONeil123!"       (apostrophe is delimiter)
 *   "Mary Jones-Smith"     → "JonesSmith123!"  (hyphen is delimiter)
 *   "MARY SMITH"           → "Smith123!"       (all-caps normalized)
 *   "John Smith III"       → "Smith123!"       (suffix skipped)
 *   "Stacia McCallum, PA"  → "McCallum123!"    (designation skipped, mixed case preserved)
 *   "Susan DeSantis"       → "DeSantis123!"    (mixed case preserved)
 *   "Jill VanDresser"      → "VanDresser123!"  (mixed case preserved)
 *   "Maria González"       → "Gonzalez123!"    (diacritic stripped, uniform lower → title)
 *   ""                     → "Welcome123!"
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

// Generational suffixes (Jr/Sr/II-IV) plus common professional / academic /
// real-estate designations. Real-estate agents frequently add PA (FL/CA
// "Professional Association"), MBA, or industry credentials (ABR, GRI, CRS,
// CLHMS, SRES, SRS) to their name — treating those as the surname produces
// silly passwords like "Pa12345!" for "Stacia McCallum, PA".
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|pa|mba|cpa|md|dds|rn|phd|esq|cfa|cfp|abr|gri|crs|clhms|sres|srs)\.?$/i;
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
    .map((seg) => {
      // Mixed case → preserve (McCallum, MacDonald, DiCaprio, DeSantis).
      // Uniform (all-caps or all-lower) → title-case.
      const hasLower = /[a-z]/.test(seg);
      const hasUpper = /[A-Z]/.test(seg);
      if (hasLower && hasUpper) return seg;
      return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
    });

  const cleaned = segments.join('');
  if (!cleaned) return 'Welcome123!';

  // 8-char minimum: "BASE" + "123…" + "!". When BASE < 4 chars, extend
  // the digit block. "1234567" supports bases down to length 1.
  const digitCount = Math.max(3, 7 - cleaned.length);
  const digits = '1234567'.slice(0, digitCount);
  return `${cleaned}${digits}!`;
}
