/**
 * Atomic Customer creation from a matched `brokerage_roster` row.
 *
 * This is the roster-driven sibling of POST /api/customers' inline create
 * transaction: it inserts the Customer + generates the workflow's tasks +
 * dependencies + the "Customer Created" event in ONE db.transaction, reusing
 * `generateTasksFromTemplate` (the same Auto-1 path the admin form and the
 * HubSpot closedwon handler use). It additionally:
 *
 *   - creates the post-verification `roster` bridge row (audit of what was
 *     copied from the source into the Customer) inside the same transaction,
 *   - stamps `brokerage_roster.customer_id` on the matched bulk-roster row so
 *     the unboarded-agent partial index stays accurate and re-submits are
 *     idempotent.
 *
 * The advisory lock + customer_id idempotency check (plan §4.2 step 5) is the
 * route's responsibility before calling this; this helper assumes it owns the
 * create.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2 (flow) + §3.4 (field mapping).
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { channelIdForCode } from '@/lib/db';
import { generateTasksFromTemplate } from '@/lib/automations/generate-tasks';

export interface RosterCustomerInput {
  /** The matched bulk-roster row id — used to set its customer_id afterwards. */
  brokerageRosterId: string;
  brokerageId: string;
  /** Channel code derived from brokerage.default_workflow_key (e.g. 'IPRE'). */
  channelCode: string;
  matchedEmail: string;

  // Mapped customer fields (see §3.4 + intake_form_prepop_mapping).
  name: string;
  businessName: string | null;
  phone: string | null;
  website: string | null;
  bio: string | null;
  licenseNumber: string | null;
  mlsIds: string | null;
  businessAddress: string | null;
  serviceAreas: string | null;
  otherEmails: string | null;
}

export interface RosterCustomerResult {
  id: string;
  accessToken: string;
}

export async function createRosterCustomer(
  input: RosterCustomerInput,
): Promise<RosterCustomerResult> {
  const channelId = await channelIdForCode(input.channelCode);
  if (!channelId) {
    throw new Error(
      `Unknown channel code '${input.channelCode}' resolved from brokerage workflow key`,
    );
  }
  const workflowKey = `B2B-${input.channelCode}`;

  return db.transaction(async (tx) => {
    // 1. Post-verification bridge row (audit of the one-time copy).
    const [rosterBridge] = await tx
      .insert(schema.roster)
      .values({
        email: input.matchedEmail,
        brokerageId: input.brokerageId,
        agentName: input.name,
        phone: input.phone,
        licenseNumber: input.licenseNumber,
        website: input.website,
        bio: input.bio,
        serviceAreas: input.serviceAreas,
        mlsIds: input.mlsIds,
        otherEmails: input.otherEmails,
        onboardingStatus: 'In Progress',
      })
      .returning();

    // 2. Customer insert.
    const [customer] = await tx
      .insert(schema.customers)
      .values({
        name: input.name,
        type: 'B2B',
        channelId,
        workflowKey,
        contactEmail: input.matchedEmail,
        platformEmail: input.matchedEmail,
        phone: input.phone,
        businessName: input.businessName,
        businessAddress: input.businessAddress,
        website: input.website,
        bio: input.bio,
        licenseNumber: input.licenseNumber,
        mlsIds: input.mlsIds,
        serviceAreas: input.serviceAreas,
        otherEmails: input.otherEmails,
        brokerageId: input.brokerageId,
        rosterRecordId: rosterBridge.id,
        currentStage: 'Getting Started',
        createdVia: 'b2b_landing',
      })
      .returning();

    // 3. Auto 1 — tasks + dependencies + "Customer Created" event (same
    //    helper the admin create + closedwon handler use). Atomic with the
    //    insert above.
    await generateTasksFromTemplate(tx, {
      customerId: customer.id,
      type: 'B2B',
      channel: input.channelCode,
      brokerageId: input.brokerageId,
      hasVoice: customer.hasVoice,
      hasAvatar: customer.hasAvatar,
    });

    // 4. Close the loop: bridge bulk-roster row → customer.
    await tx
      .update(schema.brokerageRoster)
      .set({ customerId: customer.id })
      .where(eq(schema.brokerageRoster.id, input.brokerageRosterId));

    // 5. Backfill the bridge row's customer_id too (mirrors the FK on customers).
    await tx
      .update(schema.roster)
      .set({ customerId: customer.id })
      .where(eq(schema.roster.id, rosterBridge.id));

    return { id: customer.id, accessToken: customer.accessToken };
  });
}
