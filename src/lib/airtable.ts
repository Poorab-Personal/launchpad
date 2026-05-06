import type {
  Customer,
  Task,
  TaskStatus,
  WorkflowTemplate,
  TeamMember,
  Brokerage,
  RosterAgent,
  Event,
  AirtableAttachment,
  Product,
  Call,
  CallStatus,
  CallType,
} from '@/types';
import {
  getRecords,
  getRecord,
  updateRecord,
  createRecord,
  type AirtableRecord,
} from './airtable-client';

// ─── Helpers ────────────────────────────────────────────────────────

/** Airtable single select fields return { name: "value" } objects, not strings */
function selectValue(field: unknown): string {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object' && 'name' in field) return (field as { name: string }).name;
  return '';
}

/** Airtable linked record fields return [{ id: "recXXX" }] arrays */
function linkedIds(field: unknown): string[] {
  if (Array.isArray(field)) return field.map((r) => (typeof r === 'string' ? r : r.id));
  return [];
}

/** Airtable attachment fields return [{id, url, filename, ...}] arrays */
function attachments(field: unknown): AirtableAttachment[] {
  if (!Array.isArray(field)) return [];
  return field.map((a) => ({
    url: (a as { url: string }).url,
    filename: (a as { filename?: string }).filename,
  }));
}

/** Airtable multi-select fields return [{name: "value"}, ...] arrays */
function multiSelectValues(field: unknown): string[] {
  if (!Array.isArray(field)) return [];
  return field.map((item) =>
    typeof item === 'string' ? item : (item as { name: string }).name,
  );
}

// ─── Field mapping helpers ──────────────────────────────────────────

function mapAirtableToCustomer(record: AirtableRecord): Customer {
  const f = record.fields;
  return {
    id: record.id,

    // Identity
    name: (f['Name'] as string) ?? '',
    type: (selectValue(f['Type']) as Customer['type']) || 'D2C',
    channel: (f['Channel'] as string) ?? '',
    workflowKey: (f['Workflow Key'] as string) ?? '',
    contactEmail: (f['Contact Email'] as string) ?? '',
    platformEmail: (f['Platform Email'] as string) ?? '',
    phone: (f['Phone'] as string) ?? '',

    // Business Info
    businessName: (f['Business Name'] as string) ?? '',
    businessAddress: (f['Business Address'] as string) ?? '',
    website: (f['Website'] as string) ?? '',
    serviceAreas: (f['Service Areas'] as string) ?? '',
    localContentAreas: (f['Local Content Areas'] as string) ?? '',
    bio: (f['Bio'] as string) ?? '',
    licenseNumber: (f['License Number'] as string) ?? '',
    topics: (f['Topics'] as string) ?? '',
    hashtags: (f['Hashtags'] as string) ?? '',
    gmbName: (f['GMB Name'] as string) ?? '',
    mlsIds: (f['MLS IDs'] as string) ?? '',
    specialInstructions: (f['Special Instructions'] as string) ?? '',

    // Assets
    agentPhoto: attachments(f['Agent Photo']),
    businessLogo: attachments(f['Business Logo']),
    otherAssets: attachments(f['Other Assets']),

    // Add-ons
    hasVoice: (f['Has Voice'] as boolean) ?? false,
    hasAvatar: (f['Has Avatar'] as boolean) ?? false,
    voiceStage: (f['Voice Stage'] as string) ?? '',
    avatarStage: (f['Avatar Stage'] as string) ?? '',
    voiceStripeId: (f['Voice Stripe ID'] as string) ?? '',
    avatarStripeId: (f['Avatar Stripe ID'] as string) ?? '',

    // Payment & Deal (D2C)
    hubspotDealId: (f['HubSpot Deal ID'] as string) ?? '',
    stripePaymentId: (f['Stripe Payment ID'] as string) ?? '',
    addOnStripePaymentId: (f['Add-On Stripe Payment ID'] as string) ?? '',
    productTier: (selectValue(f['Product Tier']) as Customer['productTier']) || null,
    paymentStatus: (selectValue(f['Payment Status']) as Customer['paymentStatus']) || null,

    // Enterprise (B2B)
    brokerage: linkedIds(f['Brokerage']),
    rosterRecord: linkedIds(f['Roster Record']),

    // Assignment
    csmAssigned: linkedIds(f['CSM Assigned']),

    // Design Workflow (D2C)
    designApproval: (selectValue(f['Design Approval']) as Customer['designApproval']) || null,
    designFeedback: (f['Design Feedback'] as string) ?? '',
    designRevisionCount: (f['Design Revision Count'] as number) ?? 0,
    designProof: attachments(f['Design Proof']),

    // Status Tracking
    currentStage: (f['Current Stage'] as string) ?? '',
    stageEnteredAt: (f['Stage Entered At'] as string) ?? '',
    accountCreated: (f['Account Created'] as boolean) ?? false,
    credentialsSent: (f['Credentials Sent'] as boolean) ?? false,
    callBooked: (f['Call Booked'] as boolean) ?? false,
    callCompleted: (f['Call Completed'] as boolean) ?? false,
    callDate: (f['Call Date'] as string) ?? '',
    noShowCount: (f['No Show Count'] as number) ?? 0,
    reminderCount: (f['Reminder Count'] as number) ?? 0,
    otherEmails: (f['Other Emails'] as string) ?? '',

    // System
    accessToken: record.id,
    environment: linkedIds(f['Environment']),
    portalBaseUrl: Array.isArray(f['Portal Base URL'])
      ? ((f['Portal Base URL'] as unknown[])[0] as string) ?? ''
      : ((f['Portal Base URL'] as string) ?? ''),
    tasks: linkedIds(f['Tasks']),
    events: linkedIds(f['Events']),
    createdAt: (f['Created At'] as string) ?? record.createdTime,
    lastModified: (f['Last Modified'] as string) ?? '',
  };
}

function mapAirtableToTask(record: AirtableRecord): Task {
  const f = record.fields;
  return {
    id: record.id,
    taskName: (f['Task Name'] as string) ?? '',
    customer: linkedIds(f['Customer']),
    taskType: (selectValue(f['Task Type']) as Task['taskType']) || 'Client',
    stage: (f['Stage'] as string) ?? '',
    status: (selectValue(f['Status']) as TaskStatus) || 'Draft',
    taskOrder: (f['Task Order'] as number) ?? 0,
    stageOrder: (f['Stage Order'] as number) ?? 0,
    assignedTo: linkedIds(f['Assigned To']),
    visibleToClient: (f['Visible To Client'] as boolean) ?? false,
    dependsOn: (f['Depends On'] as string) ?? '',
    hasTeamReview: (f['Has Team Review'] as boolean) ?? false,
    attachmentType: (selectValue(f['Attachment Type']) as Task['attachmentType']) || 'None',
    embedUrl: (f['Embed URL'] as string) ?? '',
    instructions: (f['Instructions'] as string) ?? '',
    tags: multiSelectValues(f['Tags']),
    notes: (f['Notes'] as string) ?? '',
    dueDate: (f['Due Date'] as string) ?? '',
    completedAt: (f['Completed At'] as string) ?? '',
    activatedAt: (f['Activated At'] as string) ?? '',
    daysActive: typeof f['Days Active'] === 'number' ? (f['Days Active'] as number) : null,
    createdAt: (f['Created At'] as string) ?? record.createdTime,
    product: (selectValue(f['Product']) as Product) || 'Core',
  };
}

function mapAirtableToWorkflowTemplate(record: AirtableRecord): WorkflowTemplate {
  const f = record.fields;
  return {
    id: record.id,
    workflowKey: (f['Workflow Key'] as string) ?? '',
    stage: (f['Stage'] as string) ?? '',
    stageOrder: (f['Stage Order'] as number) ?? 0,
    taskTitle: (f['Task Title'] as string) ?? '',
    taskType: (selectValue(f['Task Type']) as WorkflowTemplate['taskType']) || 'Client',
    taskOrder: (f['Task Order'] as number) ?? 0,
    visibleToClient: (f['Visible To Client'] as boolean) ?? false,
    assignedRole: (selectValue(f['Assigned Role']) as WorkflowTemplate['assignedRole']) || null,
    initialStatus: (selectValue(f['Initial Status']) as WorkflowTemplate['initialStatus']) || 'Draft',
    dependsOn: (f['Depends On'] as string) ?? '',
    hasTeamReview: (f['Has Team Review'] as boolean) ?? false,
    attachmentType: (selectValue(f['Attachment Type']) as WorkflowTemplate['attachmentType']) || 'None',
    embedUrl: (f['Embed URL'] as string) ?? '',
    instructions: (f['Instructions'] as string) ?? '',
    reminderAfterDays: (f['Reminder After Days'] as number) ?? 0,
    maxReminders: (f['Max Reminders'] as number) ?? 0,
    dueDaysAfterActivation: (f['Due Days After Activation'] as number) ?? 0,
    product: (selectValue(f['Product']) as Product) || 'Core',
  };
}

function mapAirtableToTeamMember(record: AirtableRecord): TeamMember {
  const f = record.fields;
  return {
    id: record.id,
    name: (f['Name'] as string) ?? '',
    email: (f['Email'] as string) ?? '',
    slackHandle: (f['Slack Handle'] as string) ?? '',
    calendlyUrl: (f['Calendly URL'] as string) ?? '',
    role: (selectValue(f['Role']) as TeamMember['role']) || 'Onboarding Ops',
    active: (f['Active'] as boolean) ?? false,
    isDefault: (f['Default'] as boolean) ?? false,
    createdAt: (f['Created At'] as string) ?? record.createdTime,
  };
}

function mapAirtableToBrokerage(record: AirtableRecord): Brokerage {
  const f = record.fields;
  return {
    id: record.id,
    name: (f['Name'] as string) ?? '',
    landingPageSlug: (f['Landing Page Slug'] as string) ?? '',
    defaultWorkflowKey: (f['Default Workflow Key'] as string) ?? '',
    rosterApiUrl: (f['Roster API URL'] as string) ?? '',
    rosterApiKey: (f['Roster API Key'] as string) ?? '',
    rosterRefreshInterval: (f['Roster Refresh Interval'] as string) ?? '',
    defaultCalendlyUrl: (f['Default Calendly URL'] as string) ?? '',
    lastRosterSync: (f['Last Roster Sync'] as string) ?? '',
    billingContact: (f['Billing Contact'] as string) ?? '',
    notes: (f['Notes'] as string) ?? '',
    active: (f['Active'] as boolean) ?? false,
    includesVoice: (f['Includes Voice'] as boolean) ?? false,
    includesAvatar: (f['Includes Avatar'] as boolean) ?? false,
    createdAt: (f['Created At'] as string) ?? record.createdTime,
  };
}

function mapAirtableToRosterAgent(record: AirtableRecord): RosterAgent {
  const f = record.fields;
  return {
    id: record.id,
    email: (f['Email'] as string) ?? '',
    brokerage: linkedIds(f['Brokerage']),
    agentName: (f['Agent Name'] as string) ?? '',
    phone: (f['Phone'] as string) ?? '',
    licenseNumber: (f['License Number'] as string) ?? '',
    website: (f['Website'] as string) ?? '',
    photoUrl: (f['Photo URL'] as string) ?? '',
    logoUrl: (f['Logo URL'] as string) ?? '',
    bio: (f['Bio'] as string) ?? '',
    serviceAreas: (f['Service Areas'] as string) ?? '',
    mlsIds: (f['MLS IDs'] as string) ?? '',
    topics: (f['Topics'] as string) ?? '',
    hashtags: (f['Hashtags'] as string) ?? '',
    gmbName: (f['GMB Name'] as string) ?? '',
    otherEmails: (f['Other Emails'] as string) ?? '',
    onboardingStatus: (selectValue(f['Onboarding Status']) as RosterAgent['onboardingStatus']) || 'Not Started',
    customerRecord: linkedIds(f['Customer Record']),
    syncedAt: (f['Synced At'] as string) ?? '',
  };
}

function mapAirtableToEvent(record: AirtableRecord): Event {
  const f = record.fields;
  return {
    id: record.id,
    eventId: (f['Event ID'] as number) ?? 0,
    customer: linkedIds(f['Customer']),
    eventType: selectValue(f['Event Type']),
    actor: linkedIds(f['Actor']),
    actorType: (selectValue(f['Actor Type']) as Event['actorType']) || 'System',
    details: (f['Details'] as string) ?? '',
    relatedTask: linkedIds(f['Related Task']),
    createdAt: (f['Created At'] as string) ?? record.createdTime,
  };
}

// ─── Public API ─────────────────────────────────────────────────────

// --- Customers ---

export async function getCustomerByToken(token: string): Promise<Customer | null> {
  try {
    const record = await getRecord('Customers', token);
    return mapAirtableToCustomer(record);
  } catch {
    return null;
  }
}

export async function getCustomers(): Promise<Customer[]> {
  const records = await getRecords('Customers');
  return records.map(mapAirtableToCustomer);
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  try {
    const record = await getRecord('Customers', id);
    return mapAirtableToCustomer(record);
  } catch {
    return null;
  }
}

export async function updateCustomerFields(
  id: string,
  fields: Record<string, unknown>,
): Promise<Customer> {
  const record = await updateRecord('Customers', id, fields);
  return mapAirtableToCustomer(record);
}

// --- Tasks ---

export async function getTasksForCustomer(customerId: string): Promise<Task[]> {
  const records = await getRecords('Tasks', {
    sort: [
      { field: 'Stage Order', direction: 'asc' },
      { field: 'Task Order', direction: 'asc' },
    ],
  });
  return records
    .filter((r) => {
      const linked = r.fields['Customer'] as Array<string> | undefined;
      return linked?.some((id) =>
        typeof id === 'string' ? id === customerId : (id as { id: string }).id === customerId,
      );
    })
    .map(mapAirtableToTask);
}

export async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
  const record = await updateRecord('Tasks', taskId, { Status: status });
  return mapAirtableToTask(record);
}

// --- Workflow Templates ---

export async function getWorkflowTemplates(workflowKey: string): Promise<WorkflowTemplate[]> {
  const records = await getRecords('Workflow Templates', {
    filterByFormula: `{Workflow Key} = '${workflowKey}'`,
    sort: [
      { field: 'Stage Order', direction: 'asc' },
      { field: 'Task Order', direction: 'asc' },
    ],
  });
  return records.map(mapAirtableToWorkflowTemplate);
}

/** Get all unique workflow keys, grouped by type (D2C/B2B) */
export async function getAvailableWorkflows(): Promise<Array<{ workflowKey: string; type: string; channel: string }>> {
  const records = await getRecords('Workflow Templates');
  const seen = new Set<string>();
  const workflows: Array<{ workflowKey: string; type: string; channel: string }> = [];
  for (const r of records) {
    const key = (r.fields['Workflow Key'] as string) ?? '';
    if (key && !seen.has(key)) {
      seen.add(key);
      const [type, ...rest] = key.split('-');
      workflows.push({ workflowKey: key, type, channel: rest.join('-') });
    }
  }
  return workflows.sort((a, b) => a.workflowKey.localeCompare(b.workflowKey));
}

// --- Events ---

export async function createEvent(
  customerId: string,
  eventType: string,
  actorType: Event['actorType'],
  details: string,
  taskId?: string,
  actorId?: string,
): Promise<Event> {
  const fields: Record<string, unknown> = {
    Customer: [customerId],
    'Event Type': eventType,
    'Actor Type': actorType,
    Details: details,
  };
  if (taskId) {
    fields['Related Task'] = [taskId];
  }
  if (actorId) {
    fields['Actor'] = [actorId];
  }
  const record = await createRecord('Events', fields);
  return mapAirtableToEvent(record);
}

/**
 * Check if all tasks in a stage are complete and advance the customer
 * to the next stage if so. Activates eligible tasks in the new stage.
 *
 * Product scoping: Core tasks advance Current Stage using {Type}-{Channel}
 * templates. Voice/Avatar tasks advance their own stage field using
 * Addon-Voice/Addon-Avatar templates.
 */
export async function checkAndAdvanceStage(
  customerId: string,
  completedTaskStage: string,
  allTasks: AirtableRecord[],
  completedNames: Set<string>,
  justCompletedTaskId?: string,
  product: Product = 'Core',
): Promise<boolean> {
  // Filter tasks to the same Product
  const productTasks = allTasks.filter((t) => {
    const p = selectValue(t.fields['Product']);
    return p === product || (!p && product === 'Core');
  });

  const stageTasks = productTasks.filter((t) => t.fields['Stage'] === completedTaskStage);
  const allStageComplete = stageTasks.every((t) => {
    return t.id === justCompletedTaskId ? true : selectValue(t.fields['Status']) === 'Completed';
  });

  if (!allStageComplete) return false;

  // Determine workflow key and stage field based on Product
  let workflowKey: string;
  let stageField: string;

  if (product === 'Voice') {
    workflowKey = 'Addon-Voice';
    stageField = 'Voice Stage';
  } else if (product === 'Avatar') {
    workflowKey = 'Addon-Avatar';
    stageField = 'Avatar Stage';
  } else {
    const customer = await getRecord('Customers', customerId);
    const type = selectValue(customer.fields['Type']);
    const channel = (customer.fields['Channel'] as string) ?? '';
    workflowKey = `${type}-${channel}`;
    stageField = 'Current Stage';
  }

  const templates = await getRecords('Workflow Templates', {
    filterByFormula: `{Workflow Key} = '${workflowKey}'`,
    sort: [{ field: 'Stage Order', direction: 'asc' }],
  });

  // Get unique stages in order
  const stageOrder: Array<{ stage: string; order: number }> = [];
  const seen = new Set<string>();
  for (const t of templates) {
    const stage = t.fields['Stage'] as string;
    if (!seen.has(stage)) {
      seen.add(stage);
      stageOrder.push({ stage, order: t.fields['Stage Order'] as number });
    }
  }

  const currentIdx = stageOrder.findIndex((s) => s.stage === completedTaskStage);
  const nextStage =
    currentIdx >= 0 && currentIdx < stageOrder.length - 1
      ? stageOrder[currentIdx + 1]
      : null;

  if (!nextStage) return false;

  const stageUpdate: Record<string, unknown> = {
    [stageField]: nextStage.stage,
  };
  if (product === 'Core') {
    stageUpdate['Stage Entered At'] = new Date().toISOString();
  }
  await updateRecord('Customers', customerId, stageUpdate);

  // Log Stage Changed event
  await createEvent(
    customerId,
    'Stage Changed',
    'System',
    `[${product}] Advanced from "${completedTaskStage}" to "${nextStage.stage}".`,
  );

  // Activate eligible tasks in the new stage (same Product, Draft with no unmet dependencies)
  const newStageTasks = productTasks.filter(
    (t) => t.fields['Stage'] === nextStage.stage,
  );
  const nowIso = new Date().toISOString();
  for (const nst of newStageTasks) {
    if (selectValue(nst.fields['Status']) !== 'Draft') continue;
    const dependsOn = (nst.fields['Depends On'] as string) ?? '';
    if (!dependsOn) {
      await updateRecord('Tasks', nst.id, { Status: 'Active', 'Activated At': nowIso });
      await createEvent(
        customerId,
        'Task Activated',
        'System',
        `Task "${nst.fields['Task Name']}" activated (new stage: ${nextStage.stage}).`,
        nst.id,
      );
    } else {
      // Check if all dependencies are met even across stages
      const deps = dependsOn.split(',').map((d) => d.trim());
      if (deps.every((dep) => completedNames.has(dep))) {
        await updateRecord('Tasks', nst.id, { Status: 'Active', 'Activated At': nowIso });
        await createEvent(
          customerId,
          'Task Activated',
          'System',
          `Task "${nst.fields['Task Name']}" activated (dependencies met).`,
          nst.id,
        );
      }
    }
  }

  return true;
}

// --- Team Members ---

export async function getTeamMembers(): Promise<TeamMember[]> {
  const records = await getRecords('Team Members');
  return records.map(mapAirtableToTeamMember);
}

export async function getTeamMembersByRole(role: string): Promise<TeamMember[]> {
  const records = await getRecords('Team Members', {
    filterByFormula: `AND({Role} = '${role}', {Active} = TRUE())`,
  });
  return records.map(mapAirtableToTeamMember);
}

/**
 * Look up an active Team Member by email. Used as the auth gate.
 * Returns null if no match or inactive.
 */
export async function getTeamMemberByEmail(email: string): Promise<TeamMember | null> {
  const safe = email.replace(/'/g, "\\'");
  const records = await getRecords('Team Members', {
    filterByFormula: `AND(LOWER({Email}) = LOWER('${safe}'), {Active} = TRUE())`,
    maxRecords: 1,
  });
  if (records.length === 0) return null;
  return mapAirtableToTeamMember(records[0]);
}

export async function getTeamMemberById(id: string): Promise<TeamMember | null> {
  try {
    const record = await getRecord('Team Members', id);
    return mapAirtableToTeamMember(record);
  } catch {
    return null;
  }
}

/**
 * Tasks where Assigned To includes the given member ID, filtered by status(es).
 * Used by the workspace queue. Pulls all tasks then filters in-memory because
 * Airtable can't filter linked-record arrays via filterByFormula reliably.
 */
export async function getTasksAssignedTo(
  memberId: string,
  statuses: TaskStatus[] = ['Active'],
): Promise<Task[]> {
  const records = await getRecords('Tasks', {
    sort: [
      { field: 'Stage Order', direction: 'asc' },
      { field: 'Task Order', direction: 'asc' },
    ],
  });
  const statusSet = new Set<string>(statuses);
  return records
    .map(mapAirtableToTask)
    .filter((t) => statusSet.has(t.status) && t.assignedTo.includes(memberId));
}

/**
 * All Core tasks matching given statuses (admin overview).
 * Used when an Admin views the queue — shows everyone's work.
 */
export async function getAllCoreTasks(
  statuses: TaskStatus[] = ['Active'],
): Promise<Task[]> {
  const records = await getRecords('Tasks', {
    sort: [
      { field: 'Stage Order', direction: 'asc' },
      { field: 'Task Order', direction: 'asc' },
    ],
  });
  const statusSet = new Set<string>(statuses);
  return records
    .map(mapAirtableToTask)
    .filter((t) => statusSet.has(t.status) && t.product === 'Core');
}

// --- Brokerages ---

export async function getBrokerageById(id: string): Promise<Brokerage | null> {
  try {
    const record = await getRecord('Brokerages', id);
    return mapAirtableToBrokerage(record);
  } catch {
    return null;
  }
}

export async function getBrokerageBySlug(slug: string): Promise<Brokerage | null> {
  const records = await getRecords('Brokerages', {
    filterByFormula: `{Landing Page Slug} = '${slug}'`,
    maxRecords: 1,
  });
  if (records.length === 0) return null;
  return mapAirtableToBrokerage(records[0]);
}

// --- Roster ---

export async function getRosterAgentByEmail(
  email: string,
  brokerageId: string,
): Promise<RosterAgent | null> {
  const records = await getRecords('Roster', {
    filterByFormula: `AND({Email} = '${email}', FIND('${brokerageId}', ARRAYJOIN(Brokerage)))`,
    maxRecords: 1,
  });
  if (records.length === 0) return null;
  return mapAirtableToRosterAgent(records[0]);
}

// --- Calls ---

function mapAirtableToCall(record: AirtableRecord): Call {
  const f = record.fields;
  return {
    id: record.id,
    title: (f['Title'] as string) ?? '',
    customer: linkedIds(f['Customer']),
    type: (selectValue(f['Type']) as CallType) || 'Ad-hoc',
    scheduledDate: (f['Scheduled Date'] as string) ?? '',
    status: (selectValue(f['Status']) as CallStatus) || 'Scheduled',
    csm: linkedIds(f['CSM']),
    notes: (f['Notes'] as string) ?? '',
    recordingUrl: (f['Recording URL'] as string) ?? '',
    calendlyEventUuid: (f['Calendly Event UUID'] as string) ?? '',
    createdAt: (f['Created At'] as string) ?? record.createdTime,
    lastModified: (f['Last Modified'] as string) ?? '',
  };
}

/**
 * Map a partial `Call` (camelCase) → Airtable Title-Case fields object.
 * Skips undefined values so callers can pass partials freely.
 */
function callFieldsToAirtable(fields: Partial<Call>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.title !== undefined) out['Title'] = fields.title;
  if (fields.customer !== undefined) out['Customer'] = fields.customer;
  if (fields.type !== undefined) out['Type'] = fields.type;
  if (fields.scheduledDate !== undefined) out['Scheduled Date'] = fields.scheduledDate;
  if (fields.status !== undefined) out['Status'] = fields.status;
  if (fields.csm !== undefined) out['CSM'] = fields.csm;
  if (fields.notes !== undefined) out['Notes'] = fields.notes;
  if (fields.recordingUrl !== undefined) out['Recording URL'] = fields.recordingUrl;
  if (fields.calendlyEventUuid !== undefined) out['Calendly Event UUID'] = fields.calendlyEventUuid;
  return out;
}

/** All Calls for a customer, oldest first by Scheduled Date. */
export async function getCallsForCustomer(customerId: string): Promise<Call[]> {
  // Use FIND on the linked-record array string representation.
  // (filterByFormula on linked records can't compare arrays, but
  //  ARRAYJOIN + FIND works because linked-record values stringify to the
  //  customer's primary field — we use the record ID via FIND on the
  //  flattened array, which Airtable supports via the id portion.)
  // Fallback: Airtable can't filter linked-record-by-ID via formula in all
  // cases. We fetch by formula on Customer name OR fall back to in-memory
  // scan. For reliability we use the in-memory approach matching how
  // getTasksForCustomer does it.
  const records = await getRecords('Calls', {
    sort: [{ field: 'Scheduled Date', direction: 'asc' }],
  });
  return records
    .filter((r) => {
      const linked = r.fields['Customer'] as Array<string | { id: string }> | undefined;
      return Array.isArray(linked) && linked.some((x) => (typeof x === 'string' ? x : x.id) === customerId);
    })
    .map(mapAirtableToCall);
}

/**
 * Upcoming scheduled calls for a CSM. Status=Scheduled, Scheduled Date in
 * the future. Optionally cap to next `daysAhead` days.
 */
export async function getUpcomingCallsForCSM(
  csmMemberId: string,
  daysAhead?: number,
): Promise<Call[]> {
  // Build filter formula using IS_AFTER for "future" and optional IS_BEFORE
  // for the daysAhead cap. Status comparison is plain string equality.
  const clauses = [`{Status} = 'Scheduled'`, `IS_AFTER({Scheduled Date}, NOW())`];
  if (daysAhead !== undefined) {
    clauses.push(`IS_BEFORE({Scheduled Date}, DATEADD(NOW(), ${Math.max(0, daysAhead)}, 'days'))`);
  }
  const records = await getRecords('Calls', {
    filterByFormula: `AND(${clauses.join(', ')})`,
    sort: [{ field: 'Scheduled Date', direction: 'asc' }],
  });
  // CSM is a linked-record array — filter in-memory (Airtable formulas
  // can't index by linked-record ID reliably).
  return records
    .filter((r) => {
      const linked = r.fields['CSM'] as Array<string | { id: string }> | undefined;
      return Array.isArray(linked) && linked.some((x) => (typeof x === 'string' ? x : x.id) === csmMemberId);
    })
    .map(mapAirtableToCall);
}

/** Look up a Call by Calendly Event UUID for idempotent webhook upserts. */
export async function getCallByCalendlyUuid(uuid: string): Promise<Call | null> {
  if (!uuid) return null;
  const safe = uuid.replace(/'/g, "\\'");
  const records = await getRecords('Calls', {
    filterByFormula: `{Calendly Event UUID} = '${safe}'`,
    maxRecords: 1,
  });
  if (records.length === 0) return null;
  return mapAirtableToCall(records[0]);
}

export async function createCall(fields: Partial<Call>): Promise<Call> {
  const record = await createRecord('Calls', callFieldsToAirtable(fields));
  return mapAirtableToCall(record);
}

export async function updateCall(id: string, fields: Partial<Call>): Promise<Call> {
  const record = await updateRecord('Calls', id, callFieldsToAirtable(fields));
  return mapAirtableToCall(record);
}
