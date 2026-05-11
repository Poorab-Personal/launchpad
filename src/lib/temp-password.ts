/**
 * Pattern-based temp password — single source of truth across the system.
 *
 * Pattern: `{Capitalize(Lastname)}123!`
 *   "John Smith"      → "Smith123!"
 *   "Sarah O'Brien"   → "O'Brien123!"
 *   "Madonna"         → "Madonna123!" (single name → that word)
 *
 * Used in three places — all derive on demand, nothing stored:
 *  1. Account Creator's Send Credentials UI (shown for confirmation)
 *  2. credentials-sent email body
 *  3. Customer portal Sign In task (so customer can copy after first login)
 *
 * The Account Creator must use this same pattern when creating the
 * customer's account in app.rejig.ai. If they deviate (rare edge case),
 * they'd have to coordinate with the customer manually — no override path
 * is built into LaunchPad to keep the system simple.
 */
export function tempPasswordFromName(name: string): string {
  const cleaned = (name ?? '').trim();
  if (!cleaned) return 'Welcome123!';
  const words = cleaned.split(/\s+/);
  const last = words[words.length - 1];
  // Capitalize first letter, leave rest untouched (preserves O'Brien, McGuire, etc.)
  const capitalized = last.charAt(0).toUpperCase() + last.slice(1);
  return `${capitalized}123!`;
}
