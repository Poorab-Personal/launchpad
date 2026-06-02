// ─── Enums / Union Types ─────────────────────────────────────────────

export type CustomerType = 'D2C' | 'B2B';

export type TaskType = 'Client' | 'Team';

export type TaskStatus = 'Draft' | 'Active' | 'In Review' | 'Completed' | 'Rejected';

export type AttachmentType = 'None' | 'Form' | 'File Upload' | 'Embed' | 'Proof' | 'Payment Setup';

export type DesignApproval = 'Pending' | 'Approved' | 'Changes Requested';

export type ProductTier = 'Premium' | 'Luxury';

export type PaymentStatus = 'Paid' | 'Waived';

export type OnboardingStatus = 'Not Started' | 'In Progress' | 'Completed';

export type PaymentMode = 'pre-paid' | 'setup-intent-at-intake' | 'invoice' | 'none';

export type AtRiskReason = 'No CC' | 'No Booking' | 'No Approval' | 'No Form' | 'CSM Flagged';

export type TeamRole =
  | 'Designer'
  | 'Senior Designer'
  | 'CSM'
  | 'Senior CSM'
  | 'Account Creator'
  | 'Sales'
  | 'Admin';

export type ActorType = 'Customer' | 'Team Member' | 'System';

/** One entry in customer.designNotes — a designer note sent with a proof,
 *  or a customer note attached to a Request Changes submission. Append-only,
 *  ordered chronologically. `uploadTask` is the task name of the round the
 *  note belongs to (e.g. "Create Designs", "Revise Design (Round 1)") so
 *  notes can be grouped by round in the UI. */
export interface DesignNote {
  from: 'designer' | 'customer';
  note: string;
  uploadTask: string | null;
  at: string;
}

export interface AirtableAttachment {
  /** Airtable-assigned attachment id (`att...`). Present on reads, omitted when writing new attachments. */
  id?: string;
  url: string;
  filename?: string;
  /** ISO timestamp set by the design-proof finalize route. Older entries
   *  (pre-2026-05-26) lack this — UI groups them as "Pre-tag" / "Untagged". */
  uploadedAt?: string;
  /** Task name that produced this upload — e.g. "Create Designs" or
   *  "Revise Design (Round 1)". Used to group the Drafts panel + Send modal
   *  by round so designers can tell which files belong to which iteration. */
  uploadTask?: string;
}

// ─── Table 1: Customers ─────────────────────────────────────────────

export interface Customer {
  id: string;

  // Identity
  name: string;
  type: CustomerType;
  channel: string;
  workflowKey: string;
  contactEmail: string;
  platformEmail: string;
  phone: string;

  // Business Info
  businessName: string;
  businessAddress: string;
  website: string;
  serviceAreas: string;
  localContentAreas: string;
  bio: string;
  licenseNumber: string;
  topics: string;
  hashtags: string;
  gmbName: string;
  mlsIds: string;
  specialInstructions: string;
  reviewSources: string[];
  zillowProfile: string;

  // Assets
  agentPhoto: AirtableAttachment[];
  businessLogo: AirtableAttachment[];
  otherAssets: AirtableAttachment[];

  // Payment & Deal (D2C)
  hubspotDealId: string;
  stripePaymentId: string;
  addOnStripePaymentId: string;
  productTier: ProductTier | null;
  paymentStatus: PaymentStatus | null;

  // HubSpot integration cross-system anchors (added 2026-05-13 with /api/webhooks/hubspot)
  hubspotContactId: string;
  hubspotTicketId: string;

  // Stripe — populated per Workflow Templates.Payment Mode (see plans/payment-mode-dropoff.md)
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  selectedStripePriceId: string;
  selectedPlanName: string;

  // Drop-off / At Risk surfacing
  atRisk: boolean;
  atRiskReason: AtRiskReason | null;

  // Enterprise (B2B)
  brokerage: string[];
  rosterRecord: string[];

  // Assignment
  csmAssigned: string[];

  // Design Workflow (D2C)
  designApproval: DesignApproval | null;
  /** Round-by-round designer↔customer note trail. Append-only.
   *  Read via latestNoteFrom(customer, 'designer'|'customer') from
   *  @/lib/design-notes. Replaces the legacy `designFeedback` string. */
  designNotes: DesignNote[];
  designRevisionCount: number;
  designProof: AirtableAttachment[];
  /** Internal design work-in-progress. Append-only by internal upload tasks. Customer never sees this. */
  designDrafts: AirtableAttachment[];
  /** Stamped only when Kaushal sends a curated set to the customer (Upload Proof to Customer or Upload Revised Proof). */
  designProofsUpdatedAt: string;

  // Add-ons
  hasVoice: boolean;
  hasAvatar: boolean;
  voiceStage: string;
  avatarStage: string;
  voiceStripeId: string;
  avatarStripeId: string;

  // Status Tracking
  currentStage: string;
  stageEnteredAt: string;
  onboardingState: string | null;                            // post-launch HS pipeline-stage mirror (Phase 2+)
  attentionReason: string | null;                            // BI-set reason for Watch/At-Risk/Critical
  attentionSetAt: string | null;                             // when attentionReason was set
  createdVia: string;                                        // 'organic' | 'closedwon' | 'b2b_landing' | 'backfill' | 'admin'
  accountCreated: boolean;
  credentialsSent: boolean;
  callBooked: boolean;
  callCompleted: boolean;
  callDate: string;
  noShowCount: number;
  otherEmails: string;

  // System
  accessToken: string;
  environment: string[];
  portalBaseUrl: string;
  tasks: string[];
  events: string[];
  createdAt: string;
  lastModified: string;
}

// ─── Table 2: Tasks ─────────────────────────────────────────────────

export type Product = 'Core' | 'Voice' | 'Avatar';

export interface Task {
  id: string;
  taskName: string;
  customer: string[];
  taskType: TaskType;
  stage: string;
  status: TaskStatus;
  taskOrder: number;
  stageOrder: number;
  assignedTo: string[];
  visibleToClient: boolean;
  dependsOn: string;
  hasTeamReview: boolean;
  attachmentType: AttachmentType;
  embedUrl: string;
  instructions: string;
  tags: string[];
  notes: string;
  dueDate: string;
  completedAt: string;
  activatedAt: string;
  daysActive: number | null;
  lastReminderAt: string;
  createdAt: string;
  product: Product;
}

// ─── Table 3: Workflow Templates ────────────────────────────────────

export interface WorkflowTemplate {
  id: string;
  workflowKey: string;
  stage: string;
  stageOrder: number;
  taskTitle: string;
  taskType: TaskType;
  taskOrder: number;
  visibleToClient: boolean;
  assignedRole: TeamRole | null;
  initialStatus: 'Active' | 'Draft';
  dependsOn: string;
  hasTeamReview: boolean;
  attachmentType: AttachmentType;
  embedUrl: string;
  instructions: string;
  dueDaysAfterActivation: number;
  product: Product;
  paymentMode: PaymentMode | null;
  trialDays: number;
  /** Newline-separated bullets, denormalized onto every WT row sharing a Workflow Key. Single writer = seed. */
  planFeatures: string;
}

// ─── Table 4: Team Members ──────────────────────────────────────────

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  slackHandle: string;
  calendlyUrl: string;
  role: TeamRole;
  active: boolean;
  isDefault: boolean;
  createdAt: string;
}

// ─── Table 5: Brokerages ────────────────────────────────────────────

export interface Brokerage {
  id: string;
  name: string;
  landingPageSlug: string;
  defaultWorkflowKey: string;
  lastRosterSync: string;
  defaultCalendlyUrl: string;
  billingContact: string;
  notes: string;
  active: boolean;
  includesVoice: boolean;
  includesAvatar: boolean;
  /** Pricing-page subhead. Supports `{Name}` substitution. Empty = caller falls back to default. */
  pricingTagline: string;
  /** Brokerage master logo (Vercel Blob). Empty = no co-brand available. */
  masterLogoUrl: string;
  /** Short display name ("IPRE", "Keyes", "B&W") for agent-facing copy. Empty = caller falls back to `name`. */
  shortName: string;
  createdAt: string;
}

// ─── Table 6: Roster ────────────────────────────────────────────────

export interface RosterAgent {
  id: string;
  email: string;
  brokerage: string[];
  agentName: string;
  phone: string;
  licenseNumber: string;
  website: string;
  photoUrl: string;
  logoUrl: string;
  bio: string;
  serviceAreas: string;
  mlsIds: string;
  topics: string;
  hashtags: string;
  gmbName: string;
  otherEmails: string;
  onboardingStatus: OnboardingStatus;
  customerRecord: string[];
  syncedAt: string;
}

// ─── Table 7: Events ────────────────────────────────────────────────

export interface Event {
  id: string;
  eventId: number;
  customer: string[];
  eventType: string;
  actor: string[];
  actorType: ActorType;
  details: string;
  relatedTask: string[];
  createdAt: string;
}

// ─── Table: Stripe Plans ────────────────────────────────────────────

export interface StripePlan {
  id: string;
  planName: string;
  workflowKey: string;
  stripePriceId: string;
  active: boolean;
  description: string;
  priceDisplay: string;
  pricePeriod: string;
  billingDetail: string;
  footnote: string;
  highlight: string;
  /** Optional. If set, used for ascending sort. Otherwise falls back to Plan Name alpha. */
  displayOrder: number | null;
}

// ─── Table 8: Calls ─────────────────────────────────────────────────

export type CallType = 'Onboarding' | 'Check-In 1' | 'Check-In 2' | 'Ad-hoc';
export type CallStatus = 'Scheduled' | 'Completed' | 'No Show' | 'Rescheduled' | 'Canceled';

export interface Call {
  id: string;
  /** Optional title — Calls table primary field. Free-form (e.g. "Onboarding — Sarah Test"). */
  title: string;
  customer: string[];
  type: CallType;
  scheduledDate: string;
  status: CallStatus;
  csm: string[];
  notes: string;
  recordingUrl: string;
  /** UUID parsed from Calendly event URI. Used to dedupe webhook deliveries. */
  calendlyEventUuid: string;
  /** From Airtable record metadata (always present). */
  createdAt: string;
  /** From `Last Modified` field if it exists in Airtable; else empty string. */
  lastModified: string;
}
