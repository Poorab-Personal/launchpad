/**
 * src/lib/db.ts — data-access layer for LaunchPad.
 *
 * Reads/writes Postgres via Drizzle. Public API returns @/types interfaces
 * (camelCase fields, matching Drizzle schema).
 *
 * Mapping notes:
 * - Linked-record arrays (e.g. Customer.brokerage: string[]) become
 *   single-FK columns. The mapper wraps the single id in a length-1
 *   array to preserve the public API.
 * - Customer.tasks / Customer.events were denormalized arrays in Airtable.
 *   Here they default to [] — callers needing them use getTasksForCustomer
 *   etc. (Per architect Q2 signoff 2026-05-11.)
 * - Customer.channel is a string code ('Standard' | 'Keyes' | 'BW'); read
 *   via a JOIN to the channels lookup table.
 * - Attachments are jsonb arrays of { url, filename, size, contentType }.
 *   Mapper wraps into AirtableAttachment shape (synthesizing id from url,
 *   width/height default 0 — we don't store image dims).
 * - TeamMember.role (singular) maps from teamMembers.roles[0] for now;
 *   full multi-role reconciliation is a follow-up. (Auditor 2026-05-11.)
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import * as schema from '@/db/schema';
import type {
  AirtableAttachment,
  Brokerage,
  Call,
  Customer,
  Event,
  RosterAgent,
  StripePlan,
  Task,
  TaskStatus,
  TeamMember,
  WorkflowTemplate,
} from '@/types';

// ─── Helpers ────────────────────────────────────────────────────────────

const db = defaultDb;

function iso(d: Date | null | undefined): string {
  return d ? d.toISOString() : '';
}

function arrFromId(id: string | null): string[] {
  return id ? [id] : [];
}

function mapAttachments(raw: unknown): AirtableAttachment[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((a, i) => ({
    id: String(a.id ?? a.filename ?? `att${i}`),
    url: String(a.url ?? ''),
    filename: String(a.filename ?? ''),
    size: Number(a.size ?? 0),
    type: String(a.contentType ?? a.type ?? ''),
    width: Number(a.width ?? 0),
    height: Number(a.height ?? 0),
  }));
}

// ─── Mappers (Drizzle row → TS type) ────────────────────────────────────

type CustomerRow = typeof schema.customers.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type WorkflowTemplateRow = typeof schema.workflowTemplates.$inferSelect;
type TeamMemberRow = typeof schema.teamMembers.$inferSelect;
type BrokerageRow = typeof schema.brokerages.$inferSelect;
type RosterRow = typeof schema.roster.$inferSelect;
type CallRow = typeof schema.calls.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;
type StripePlanRow = typeof schema.stripePlans.$inferSelect;

function mapDbCustomer(row: CustomerRow, channelCode: string): Customer {
  return {
    id: row.id,

    // Identity
    name: row.name,
    type: row.type,
    channel: channelCode,
    workflowKey: row.workflowKey,
    contactEmail: row.contactEmail,
    platformEmail: row.platformEmail,
    phone: row.phone ?? '',

    // Business info
    businessName: row.businessName ?? '',
    businessAddress: row.businessAddress ?? '',
    website: row.website ?? '',
    serviceAreas: row.serviceAreas ?? '',
    localContentAreas: row.localContentAreas ?? '',
    bio: row.bio ?? '',
    licenseNumber: row.licenseNumber ?? '',
    topics: row.topics ?? '',
    hashtags: row.hashtags ?? '',
    gmbName: row.gmbName ?? '',
    mlsIds: row.mlsIds ?? '',
    specialInstructions: row.specialInstructions ?? '',

    // Assets
    agentPhoto: mapAttachments(row.agentPhoto),
    businessLogo: mapAttachments(row.businessLogo),
    otherAssets: mapAttachments(row.otherAssets),

    // Add-ons
    hasVoice: row.hasVoice,
    hasAvatar: row.hasAvatar,
    voiceStage: row.voiceStage ?? '',
    avatarStage: row.avatarStage ?? '',
    voiceStripeId: row.voiceStripeId ?? '',
    avatarStripeId: row.avatarStripeId ?? '',

    // Payment & deal (D2C)
    hubspotDealId: row.hubspotDealId ?? '',
    stripePaymentId: row.stripePaymentId ?? '',
    addOnStripePaymentId: row.addOnStripePaymentId ?? '',
    productTier: row.productTier,
    paymentStatus: row.paymentStatus,

    // HubSpot integration cross-system anchors
    hubspotContactId: row.hubspotContactId ?? '',
    hubspotTicketId: row.hubspotTicketId ?? '',

    // Enterprise (B2B)
    brokerage: arrFromId(row.brokerageId),
    rosterRecord: arrFromId(row.rosterRecordId),

    // Assignment
    csmAssigned: arrFromId(row.csmTeamMemberId),

    // Design workflow (D2C)
    designApproval: row.designApproval as Customer['designApproval'],
    designFeedback: row.designFeedback ?? '',
    designRevisionCount: row.designRevisionCount,
    designProof: mapAttachments(row.designProof),
    designDrafts: mapAttachments(row.designDrafts),
    designProofsUpdatedAt: iso(row.designProofsUpdatedAt),

    // Status tracking
    currentStage: row.currentStage,
    stageEnteredAt: iso(row.stageEnteredAt),
    accountCreated: row.accountCreated,
    credentialsSent: row.credentialsSent,
    callBooked: row.callBooked,
    callCompleted: row.callCompleted,
    callDate: iso(row.callDate),
    noShowCount: row.noShowCount,
    otherEmails: row.otherEmails ?? '',
    // feedbackRating / feedbackComments aren't in the legacy Customer
    // interface; we read them off the row directly when needed. Not part
    // of mapper output to keep the public Customer type unchanged.

    // Stripe + drop-off (Phase 0 fields)
    stripeCustomerId: row.stripeCustomerId ?? '',
    stripeSubscriptionId: row.stripeSubscriptionId ?? '',
    selectedStripePriceId: row.selectedStripePriceId ?? '',
    selectedPlanName: row.selectedPlanName ?? '',
    atRisk: row.atRisk,
    atRiskReason: row.atRiskReason as Customer['atRiskReason'],

    // System
    accessToken: row.accessToken,
    environment: row.environment ?? [],
    portalBaseUrl: '',                            // filled by Settings reader at write time; '' default lets routes fallback
    tasks: [],                                    // hydrated via getTasksForCustomer() — see header note
    events: [],                                   // same
    createdAt: iso(row.createdAt),
    lastModified: iso(row.lastModified),
  };
}

/**
 * Build a `taskId → "Dep One, Dep Two"` map for a set of tasks. Reads the
 * junction table once and joins by task name (matching the legacy
 * comma-separated `Depends On` field the client expects). The customer
 * portal's optimistic-activation logic + isTaskLocked + tooltips read
 * Task.dependsOn — without this, those features silently no-op.
 */
async function buildDependsOnMap(taskRows: TaskRow[]): Promise<Map<string, string>> {
  if (taskRows.length === 0) return new Map();
  const taskIds = taskRows.map((t) => t.id);
  const deps = await db
    .select()
    .from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, taskIds));
  // Need names of source tasks. They may or may not be in taskRows (cross-customer
  // shouldn't happen in practice, but be safe). Build a name lookup from taskRows
  // first; fall back to a row query if any source is missing.
  const nameById = new Map(taskRows.map((t) => [t.id, t.taskName]));
  const missing = deps.filter((d) => !nameById.has(d.dependsOnTaskId)).map((d) => d.dependsOnTaskId);
  if (missing.length > 0) {
    const extra = await db
      .select({ id: schema.tasks.id, taskName: schema.tasks.taskName })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, missing));
    for (const e of extra) nameById.set(e.id, e.taskName);
  }
  const byTask = new Map<string, string[]>();
  for (const d of deps) {
    const name = nameById.get(d.dependsOnTaskId);
    if (!name) continue;
    const arr = byTask.get(d.taskId) ?? [];
    arr.push(name);
    byTask.set(d.taskId, arr);
  }
  const result = new Map<string, string>();
  for (const [taskId, names] of byTask) result.set(taskId, names.join(', '));
  return result;
}

function mapDbTask(row: TaskRow, dependsOnString = ''): Task {
  return {
    id: row.id,
    taskName: row.taskName,
    customer: [row.customerId],
    taskType: row.taskType as Task['taskType'],
    stage: row.stage,
    status: row.status as TaskStatus,
    taskOrder: row.taskOrder,
    stageOrder: row.stageOrder,
    assignedTo: arrFromId(row.assignedToTeamMemberId),
    visibleToClient: row.visibleToClient,
    dependsOn: dependsOnString,                   // comma-separated task names, rebuilt from junction table by callers
    hasTeamReview: row.hasTeamReview,
    attachmentType: row.attachmentType as Task['attachmentType'],
    embedUrl: row.embedUrl ?? '',
    instructions: row.instructions ?? '',
    tags: row.tags ?? [],
    notes: row.notes ?? '',
    dueDate: row.dueDate ?? '',
    completedAt: iso(row.completedAt),
    activatedAt: iso(row.activatedAt),
    daysActive: null,                             // computed in queries when needed (NOW() can't be a generated column)
    lastReminderAt: iso(row.lastReminderAt),
    createdAt: iso(row.createdAt),
    product: row.product as Task['product'],
  };
}

function mapDbWorkflowTemplate(row: WorkflowTemplateRow): WorkflowTemplate {
  return {
    id: row.id,
    workflowKey: row.workflowKey,
    stage: row.stage,
    stageOrder: row.stageOrder,
    taskTitle: row.taskTitle,
    taskType: row.taskType as WorkflowTemplate['taskType'],
    taskOrder: row.taskOrder,
    visibleToClient: row.visibleToClient,
    assignedRole: row.assignedRole as WorkflowTemplate['assignedRole'],
    initialStatus: row.initialStatus as WorkflowTemplate['initialStatus'],
    dependsOn: row.dependsOn ?? '',
    hasTeamReview: row.hasTeamReview,
    attachmentType: row.attachmentType as WorkflowTemplate['attachmentType'],
    embedUrl: row.embedUrl ?? '',
    instructions: row.instructions ?? '',
    dueDaysAfterActivation: row.dueDaysAfterActivation ?? 0,
    product: row.product as WorkflowTemplate['product'],
    paymentMode: row.paymentMode,
    trialDays: row.trialDays ?? 0,
    planFeatures: row.planFeatures ?? '',
  };
}

function mapDbTeamMember(row: TeamMemberRow): TeamMember {
  // Legacy TeamMember.role is singular; Drizzle schema is roles[] (multi).
  // Map the first role to preserve the existing public type until a
  // separate reconcile-to-multi commit lands.
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    slackHandle: row.slackHandle ?? '',
    calendlyUrl: row.calendlyUrl ?? '',
    role: (row.roles[0] ?? 'Account Creator') as TeamMember['role'],
    active: row.active,
    isDefault: row.isDefault,
    createdAt: iso(row.createdAt),
  };
}

function mapDbBrokerage(row: BrokerageRow): Brokerage {
  return {
    id: row.id,
    name: row.name,
    landingPageSlug: row.landingPageSlug,
    defaultWorkflowKey: row.defaultWorkflowKey,
    rosterApiUrl: row.rosterApiUrl ?? '',
    rosterApiKey: row.rosterApiKey ?? '',
    rosterRefreshInterval: row.rosterRefreshInterval ?? '',
    defaultCalendlyUrl: row.defaultCalendlyUrl ?? '',
    lastRosterSync: iso(row.lastRosterSync),
    billingContact: row.billingContact ?? '',
    notes: row.notes ?? '',
    active: row.active,
    includesVoice: row.includesVoice,
    includesAvatar: row.includesAvatar,
    pricingTagline: row.pricingTagline ?? '',
    createdAt: iso(row.createdAt),
  };
}

function mapDbRosterAgent(row: RosterRow): RosterAgent {
  return {
    id: row.id,
    email: row.email,
    brokerage: arrFromId(row.brokerageId),
    agentName: row.agentName ?? '',
    phone: row.phone ?? '',
    licenseNumber: row.licenseNumber ?? '',
    website: row.website ?? '',
    photoUrl: row.photoUrl ?? '',
    logoUrl: row.logoUrl ?? '',
    bio: row.bio ?? '',
    serviceAreas: row.serviceAreas ?? '',
    mlsIds: row.mlsIds ?? '',
    topics: row.topics ?? '',
    hashtags: row.hashtags ?? '',
    gmbName: row.gmbName ?? '',
    otherEmails: row.otherEmails ?? '',
    onboardingStatus: row.onboardingStatus as RosterAgent['onboardingStatus'],
    customerRecord: arrFromId(row.customerId),
    syncedAt: iso(row.syncedAt),
  };
}

function mapDbCall(row: CallRow): Call {
  return {
    id: row.id,
    title: row.title ?? '',
    customer: [row.customerId],
    type: row.type as Call['type'],
    scheduledDate: iso(row.scheduledDate),
    status: row.status as Call['status'],
    csm: arrFromId(row.csmTeamMemberId),
    notes: row.notes ?? '',
    recordingUrl: row.recordingUrl ?? '',
    calendlyEventUuid: row.calendlyEventUuid ?? '',
    createdAt: iso(row.createdAt),
    lastModified: iso(row.lastModified),
  };
}

function mapDbEvent(row: EventRow): Event {
  return {
    id: row.id,
    eventId: row.eventNumber,
    customer: arrFromId(row.customerId),
    eventType: row.eventType,
    actor: arrFromId(row.actorTeamMemberId),
    actorType: row.actorType,
    details: typeof row.details === 'string' ? row.details : JSON.stringify(row.details ?? ''),
    relatedTask: arrFromId(row.relatedTaskId),
    createdAt: iso(row.createdAt),
  };
}

function mapDbStripePlan(row: StripePlanRow): StripePlan {
  return {
    id: row.id,
    planName: row.planName,
    workflowKey: row.workflowKey,
    stripePriceId: row.stripePriceId,
    active: row.active,
    description: row.description ?? '',
    priceDisplay: row.priceDisplay ?? '',
    pricePeriod: row.pricePeriod ?? '',
    billingDetail: row.billingDetail ?? '',
    footnote: row.footnote ?? '',
    highlight: row.highlight ?? '',
    displayOrder: row.displayOrder,
  };
}

// ─── Channel lookup cache ───────────────────────────────────────────────
// Tiny memo so mapping a list of customers doesn't N+1 the channels join.

let channelCodeCacheById: Map<string, string> | null = null;
let channelIdCacheByCode: Map<string, string> | null = null;
async function loadChannelMaps(): Promise<void> {
  if (channelCodeCacheById && channelIdCacheByCode) return;
  const rows = await db.select().from(schema.channels);
  channelCodeCacheById = new Map(rows.map((r) => [r.id, r.code]));
  channelIdCacheByCode = new Map(rows.map((r) => [r.code, r.id]));
}
function clearChannelCache(): void {
  channelCodeCacheById = null;
  channelIdCacheByCode = null;
}
async function channelCodeFor(id: string): Promise<string> {
  await loadChannelMaps();
  return channelCodeCacheById!.get(id) ?? '';
}
async function channelIdForCode(code: string): Promise<string | null> {
  await loadChannelMaps();
  return channelIdCacheByCode!.get(code) ?? null;
}

// ─── Public API: Customers ──────────────────────────────────────────────

export async function getCustomerByToken(token: string): Promise<Customer | null> {
  const row = await db.query.customers.findFirst({
    where: eq(schema.customers.accessToken, token),
  });
  if (!row) return null;
  return mapDbCustomer(row, await channelCodeFor(row.channelId));
}

export async function getCustomers(): Promise<Customer[]> {
  const rows = await db.select().from(schema.customers);
  await loadChannelMaps();
  return rows.map((r) => mapDbCustomer(r, channelCodeCacheById!.get(r.channelId) ?? ''));
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const row = await db.query.customers.findFirst({
    where: eq(schema.customers.id, id),
  });
  if (!row) return null;
  return mapDbCustomer(row, await channelCodeFor(row.channelId));
}

/** Look up a Customer by Contact Email (case-insensitive). */
export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  const row = await db.query.customers.findFirst({
    where: sql`LOWER(${schema.customers.contactEmail}) = LOWER(${email})`,
  });
  if (!row) return null;
  return mapDbCustomer(row, await channelCodeFor(row.channelId));
}

/**
 * Create a new Customer. Required: name, contactEmail, platformEmail,
 * type, and either `channel` (code: 'Standard'|'Keyes'|'BW') OR a
 * pre-resolved `channelId`.
 *
 * workflowKey is computed app-side from type + channel.code per architect
 * Q1 signoff 2026-05-11 (no Postgres generated column because channels is
 * a FK lookup, not an inline string).
 */
export async function createCustomer(args: {
  name: string;
  contactEmail: string;
  platformEmail: string;
  type: Customer['type'];
  channel: string;                                                   // code: 'Standard' | 'Keyes' | 'BW'
  currentStage: string;
} & Partial<Omit<typeof schema.customers.$inferInsert, 'channelId' | 'workflowKey'>>): Promise<Customer> {
  const { channel, ...rest } = args;
  const channelId = await channelIdForCode(channel);
  if (!channelId) throw new Error(`Unknown channel code: ${channel}`);
  const workflowKey = `${args.type}-${channel}`;
  const [row] = await db
    .insert(schema.customers)
    .values({ ...rest, channelId, workflowKey })
    .returning();
  return mapDbCustomer(row, channel);
}

/**
 * Update Customer fields. Accepts camelCase keys matching the Drizzle schema.
 * Example: `{ stripeCustomerId: 'cus_x' }`.
 *
 * Routes still passing Title Case keys will silently get the wrong shape;
 * Phase 2.3 (consumer swap) updates all callers in lockstep.
 */
export async function updateCustomerFields(
  id: string,
  fields: Partial<typeof schema.customers.$inferInsert>,
): Promise<Customer> {
  const [row] = await db
    .update(schema.customers)
    .set(fields)
    .where(eq(schema.customers.id, id))
    .returning();
  if (!row) throw new Error(`Customer ${id} not found`);
  return mapDbCustomer(row, await channelCodeFor(row.channelId));
}

// ─── Public API: Tasks ──────────────────────────────────────────────────

export async function getTasksForCustomer(customerId: string): Promise<Task[]> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.customerId, customerId))
    .orderBy(asc(schema.tasks.stageOrder), asc(schema.tasks.taskOrder));
  const depsMap = await buildDependsOnMap(rows);
  return rows.map((r) => mapDbTask(r, depsMap.get(r.id) ?? ''));
}

export async function getTaskById(taskId: string): Promise<Task | null> {
  const row = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  if (!row) return null;
  const depsMap = await buildDependsOnMap([row]);
  return mapDbTask(row, depsMap.get(row.id) ?? '');
}

/**
 * Generic partial Task update. Accepts camelCase fields matching the Drizzle
 * schema. If the update flips status to Completed, fires Auto 2 (activate
 * dependents + advance stage) post-write. The Auto 2 trigger is dynamically
 * imported to avoid a circular dep with src/lib/automations/.
 */
export async function updateTaskFields(
  taskId: string,
  fields: Partial<typeof schema.tasks.$inferInsert>,
): Promise<Task> {
  const [row] = await db
    .update(schema.tasks)
    .set(fields)
    .where(eq(schema.tasks.id, taskId))
    .returning();
  if (!row) throw new Error(`Task ${taskId} not found`);
  if (row.status === 'Completed') {
    const { handleTaskCompleted } = await import('@/lib/automations/activate-dependents');
    await handleTaskCompleted(row.id);
  }
  return mapDbTask(row);
}

/** All tasks, ordered by stage/task order. Used by webhooks + workspace dashboards. */
export async function getAllTasks(): Promise<Task[]> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .orderBy(asc(schema.tasks.stageOrder), asc(schema.tasks.taskOrder));
  const depsMap = await buildDependsOnMap(rows);
  return rows.map((r) => mapDbTask(r, depsMap.get(r.id) ?? ''));
}

export async function createTask(
  fields: typeof schema.tasks.$inferInsert,
): Promise<Task> {
  const [row] = await db.insert(schema.tasks).values(fields).returning();
  return mapDbTask(row);
}

export async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
  const now = new Date();
  const update: Partial<typeof schema.tasks.$inferInsert> = { status };
  if (status === 'Completed') update.completedAt = now;
  if (status === 'Active') update.activatedAt = now;
  const [row] = await db
    .update(schema.tasks)
    .set(update)
    .where(eq(schema.tasks.id, taskId))
    .returning();
  if (!row) throw new Error(`Task ${taskId} not found`);
  if (status === 'Completed') {
    const { handleTaskCompleted } = await import('@/lib/automations/activate-dependents');
    await handleTaskCompleted(row.id);
  }
  return mapDbTask(row);
}

/** Active tasks grouped by customer. Heavy query — used by dashboard views. */
export async function getActiveTasksByCustomer(): Promise<Map<string, Task[]>> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(inArray(schema.tasks.status, ['Active', 'In Review']))
    .orderBy(asc(schema.tasks.stageOrder), asc(schema.tasks.taskOrder));
  const depsMap = await buildDependsOnMap(rows);
  const result = new Map<string, Task[]>();
  for (const r of rows) {
    const t = mapDbTask(r, depsMap.get(r.id) ?? '');
    const arr = result.get(r.customerId) ?? [];
    arr.push(t);
    result.set(r.customerId, arr);
  }
  return result;
}

export async function getTasksAssignedTo(
  teamMemberId: string,
  statuses: TaskStatus[] = ['Active'],
): Promise<Task[]> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.assignedToTeamMemberId, teamMemberId),
        inArray(schema.tasks.status, statuses),
      ),
    )
    .orderBy(asc(schema.tasks.stageOrder), asc(schema.tasks.taskOrder));
  const depsMap = await buildDependsOnMap(rows);
  return rows.map((r) => mapDbTask(r, depsMap.get(r.id) ?? ''));
}

/**
 * All Core-product tasks across the org. Used by aggregate workspace views.
 * Defaults to Active-only.
 */
export async function getAllCoreTasks(
  statuses: TaskStatus[] = ['Active'],
): Promise<Task[]> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.product, 'Core'), inArray(schema.tasks.status, statuses)))
    .orderBy(asc(schema.tasks.stageOrder), asc(schema.tasks.taskOrder));
  const depsMap = await buildDependsOnMap(rows);
  return rows.map((r) => mapDbTask(r, depsMap.get(r.id) ?? ''));
}

// ─── Public API: Workflow Templates ─────────────────────────────────────

export async function getWorkflowTemplates(workflowKey: string): Promise<WorkflowTemplate[]> {
  const rows = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.workflowKey, workflowKey))
    .orderBy(asc(schema.workflowTemplates.stageOrder), asc(schema.workflowTemplates.taskOrder));
  return rows.map(mapDbWorkflowTemplate);
}

export async function getAvailableWorkflows(): Promise<
  Array<{ workflowKey: string; type: string; channel: string }>
> {
  // Distinct workflow_keys; split each into type + channel using the `-`
  // separator (matches the existing public API shape).
  const rows = await db
    .selectDistinct({ workflowKey: schema.workflowTemplates.workflowKey })
    .from(schema.workflowTemplates)
    .orderBy(asc(schema.workflowTemplates.workflowKey));
  return rows.map((r) => {
    const [type, ...rest] = r.workflowKey.split('-');
    return { workflowKey: r.workflowKey, type, channel: rest.join('-') };
  });
}

// ─── Public API: Events ─────────────────────────────────────────────────

/**
 * Create an event. Positional signature: (customerId, eventType, actorType,
 * details, taskId?, actorId?, callId?). All but the first four are optional.
 */
export async function createEvent(
  customerId: string | null,
  eventType: string,
  actorType: Event['actorType'],
  details: string | object,
  taskId?: string | null,
  actorTeamMemberId?: string | null,
  callId?: string | null,
): Promise<Event> {
  const [row] = await db
    .insert(schema.events)
    .values({
      customerId: customerId ?? null,
      eventType,
      actorTeamMemberId: actorTeamMemberId ?? null,
      actorType,
      details: details ?? null,
      relatedTaskId: taskId ?? null,
      relatedCallId: callId ?? null,
    })
    .returning();
  return mapDbEvent(row);
}

// ─── Public API: Team Members ───────────────────────────────────────────

export async function getTeamMembers(): Promise<TeamMember[]> {
  const rows = await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.active, true));
  return rows.map(mapDbTeamMember);
}

export async function getTeamMembersByRole(role: string): Promise<TeamMember[]> {
  // roles is a Postgres enum array. ANY(roles) check via sql template.
  const rows = await db
    .select()
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.active, true),
        sql`${role} = ANY(${schema.teamMembers.roles})`,
      ),
    );
  return rows.map(mapDbTeamMember);
}

/**
 * Resolve a team member for an Auto 1 assignment. Picks the active member
 * flagged `is_default = true` for the role; falls back to any active
 * member with the role. Returns null if no active member has the role.
 */
export async function resolveDefaultTeamMemberForRole(
  role: string,
): Promise<TeamMember | null> {
  const defaultRow = await db.query.teamMembers.findFirst({
    where: and(
      eq(schema.teamMembers.active, true),
      eq(schema.teamMembers.isDefault, true),
      sql`${role} = ANY(${schema.teamMembers.roles})`,
    ),
  });
  if (defaultRow) return mapDbTeamMember(defaultRow);
  const anyRow = await db.query.teamMembers.findFirst({
    where: and(
      eq(schema.teamMembers.active, true),
      sql`${role} = ANY(${schema.teamMembers.roles})`,
    ),
  });
  return anyRow ? mapDbTeamMember(anyRow) : null;
}

export async function getTeamMemberByEmail(email: string): Promise<TeamMember | null> {
  const row = await db.query.teamMembers.findFirst({
    where: eq(schema.teamMembers.email, email),
  });
  return row ? mapDbTeamMember(row) : null;
}

export async function getTeamMemberById(id: string): Promise<TeamMember | null> {
  const row = await db.query.teamMembers.findFirst({
    where: eq(schema.teamMembers.id, id),
  });
  return row ? mapDbTeamMember(row) : null;
}

// ─── Public API: Brokerages ─────────────────────────────────────────────

export async function getBrokerageById(id: string): Promise<Brokerage | null> {
  const row = await db.query.brokerages.findFirst({
    where: eq(schema.brokerages.id, id),
  });
  return row ? mapDbBrokerage(row) : null;
}

export async function getBrokerageByDefaultWorkflowKey(
  workflowKey: string,
): Promise<Brokerage | null> {
  const row = await db.query.brokerages.findFirst({
    where: eq(schema.brokerages.defaultWorkflowKey, workflowKey),
  });
  return row ? mapDbBrokerage(row) : null;
}

export async function getBrokerageBySlug(slug: string): Promise<Brokerage | null> {
  const row = await db.query.brokerages.findFirst({
    where: eq(schema.brokerages.landingPageSlug, slug),
  });
  return row ? mapDbBrokerage(row) : null;
}

// ─── Public API: Roster ─────────────────────────────────────────────────

export async function getRosterAgentByEmail(
  email: string,
  brokerageId?: string,
): Promise<RosterAgent | null> {
  const whereClause = brokerageId
    ? and(eq(schema.roster.email, email), eq(schema.roster.brokerageId, brokerageId))
    : eq(schema.roster.email, email);
  const row = await db.query.roster.findFirst({ where: whereClause });
  return row ? mapDbRosterAgent(row) : null;
}

// ─── Public API: Calls ──────────────────────────────────────────────────

export async function getCallsForCustomer(customerId: string): Promise<Call[]> {
  const rows = await db
    .select()
    .from(schema.calls)
    .where(eq(schema.calls.customerId, customerId))
    .orderBy(desc(schema.calls.scheduledDate));
  return rows.map(mapDbCall);
}

export async function getUpcomingCallsForCSM(
  csmTeamMemberId: string,
  daysAhead?: number,
): Promise<Call[]> {
  const now = new Date();
  const upper =
    daysAhead !== undefined
      ? new Date(now.getTime() + Math.max(0, daysAhead) * 24 * 60 * 60 * 1000)
      : null;

  const whereClauses = [
    eq(schema.calls.csmTeamMemberId, csmTeamMemberId),
    eq(schema.calls.status, 'Scheduled'),
    sql`${schema.calls.scheduledDate} > ${now}`,
  ];
  if (upper) {
    whereClauses.push(sql`${schema.calls.scheduledDate} < ${upper}`);
  }

  const rows = await db
    .select()
    .from(schema.calls)
    .where(and(...whereClauses))
    .orderBy(asc(schema.calls.scheduledDate));
  return rows.map(mapDbCall);
}

export async function getCallById(id: string): Promise<Call | null> {
  const row = await db.query.calls.findFirst({ where: eq(schema.calls.id, id) });
  return row ? mapDbCall(row) : null;
}

export async function getCallByCalendlyUuid(uuid: string): Promise<Call | null> {
  const row = await db.query.calls.findFirst({
    where: eq(schema.calls.calendlyEventUuid, uuid),
  });
  return row ? mapDbCall(row) : null;
}

export async function createCall(fields: Partial<Call>): Promise<Call> {
  const [row] = await db
    .insert(schema.calls)
    .values({
      customerId: fields.customer?.[0] ?? '',
      title: fields.title ?? null,
      type: (fields.type ?? 'Onboarding') as Call['type'],
      scheduledDate: fields.scheduledDate ? new Date(fields.scheduledDate) : new Date(),
      status: (fields.status ?? 'Scheduled') as Call['status'],
      csmTeamMemberId: fields.csm?.[0] ?? null,
      notes: fields.notes ?? null,
      recordingUrl: fields.recordingUrl ?? null,
      calendlyEventUuid: fields.calendlyEventUuid ?? null,
    })
    .returning();
  return mapDbCall(row);
}

export async function updateCall(id: string, fields: Partial<Call>): Promise<Call> {
  const update: Partial<typeof schema.calls.$inferInsert> = {};
  if (fields.title !== undefined) update.title = fields.title;
  if (fields.type !== undefined) update.type = fields.type;
  if (fields.scheduledDate !== undefined)
    update.scheduledDate = new Date(fields.scheduledDate);
  if (fields.status !== undefined) update.status = fields.status;
  if (fields.csm !== undefined) update.csmTeamMemberId = fields.csm[0] ?? null;
  if (fields.notes !== undefined) update.notes = fields.notes;
  if (fields.recordingUrl !== undefined) update.recordingUrl = fields.recordingUrl;
  if (fields.calendlyEventUuid !== undefined)
    update.calendlyEventUuid = fields.calendlyEventUuid;

  const [row] = await db
    .update(schema.calls)
    .set(update)
    .where(eq(schema.calls.id, id))
    .returning();
  if (!row) throw new Error(`Call ${id} not found`);

  // Auto 8 hook: Onboarding call flipped to Completed → create Stripe sub
  // for setup-intent-at-intake workflows. Idempotency guards inside
  // handleCallCompleted prevent double-creation on re-fire.
  if (row.status === 'Completed' && row.type === 'Onboarding') {
    const { handleCallCompleted } = await import(
      '@/lib/automations/handle-call-completed'
    );
    const result = await handleCallCompleted(row.id);
    if (result.kind === 'error') {
      console.error(`[updateCall] Auto 8 error for call ${row.id}: ${result.error}`);
    }
  }

  return mapDbCall(row);
}

// ─── Public API: Stripe Plans ───────────────────────────────────────────

export async function getStripePlansByWorkflow(workflowKey: string): Promise<StripePlan[]> {
  const rows = await db
    .select()
    .from(schema.stripePlans)
    .where(
      and(
        eq(schema.stripePlans.workflowKey, workflowKey),
        eq(schema.stripePlans.active, true),
      ),
    )
    .orderBy(asc(schema.stripePlans.displayOrder), asc(schema.stripePlans.planName));
  return rows.map(mapDbStripePlan);
}

export async function getStripePlanByPriceId(priceId: string): Promise<StripePlan | null> {
  const row = await db.query.stripePlans.findFirst({
    where: eq(schema.stripePlans.stripePriceId, priceId),
  });
  return row ? mapDbStripePlan(row) : null;
}

// ─── Public API: Settings ───────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.query.settings.findFirst({
    where: eq(schema.settings.key, key),
  });
  return row?.value ?? null;
}

// ─── Cache invalidation hook ────────────────────────────────────────────

export { clearChannelCache, channelIdForCode };
