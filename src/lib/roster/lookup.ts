/**
 * Roster lookup — match an agent's typed email against the cached
 * `brokerage_roster` for one brokerage.
 *
 * Cached-only. No live source refresh on lookup — the cached weekly roster
 * is fine because the agent confirms their data on the intake form.
 * (See docs/integrations/dmg-roster-plan.md §4.2 step 3.)
 *
 * Match rule:
 *   - Case-insensitive equality on either `public_email` or `private_email`.
 *   - Only alive rows (`deleted_at IS NULL`).
 *   - First match wins; LIMIT 1.
 *
 * Returns the matched roster row plus a discriminator indicating which
 * email column matched so the verification handler in Phase 3 can use the
 * canonical roster email (not the typed casing) as
 * `customers.contact_email` / `customers.platform_email`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import type { BrokerageRoster } from '@/db/schema/brokerageRoster';

export interface LookupHit {
  row: BrokerageRoster;
  matchedEmail: 'public' | 'private';
}

export async function lookupByEmail(
  brokerageId: string,
  email: string,
): Promise<LookupHit | null> {
  // Normalize once; let Postgres LOWER() handle the column side. Index is
  // partial on (LOWER(public_email|private_email), brokerage_id) WHERE
  // deleted_at IS NULL — matches the query plan we want.
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return null;

  const rows = await db
    .select()
    .from(schema.brokerageRoster)
    .where(
      and(
        eq(schema.brokerageRoster.brokerageId, brokerageId),
        sql`${schema.brokerageRoster.deletedAt} IS NULL`,
        sql`(LOWER(${schema.brokerageRoster.publicEmail}) = ${normalized}
             OR LOWER(${schema.brokerageRoster.privateEmail}) = ${normalized})`,
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];

  // Determine which column actually matched. Public wins on tie (the
  // outward-facing email is the "canonical" choice on the customer record).
  const matchedEmail: 'public' | 'private' =
    row.publicEmail && row.publicEmail.toLowerCase() === normalized
      ? 'public'
      : 'private';

  return { row, matchedEmail };
}
