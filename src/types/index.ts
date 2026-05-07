// ─── Enums / Union Types ─────────────────────────────────────────────

export type CustomerType = 'D2C' | 'B2B';

export type TaskType = 'Client' | 'Team';

export type TaskStatus = 'Draft' | 'Active' | 'In Review' | 'Completed' | 'Rejected';

export type AttachmentType = 'None' | 'Form' | 'File Upload' | 'Embed' | 'Proof';

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
  | 'Onboarding Ops'
  | 'Sales'
  | 'Admin';

export type ActorType = 'Customer' | 'Team Member' | 'System';

export interface AirtableAttachment {
  url: string;
  filename?: string;
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

  // Stripe — populated per Workflow Templates.Payment Mode (see plans/payment-mode-dropoff.md)
  stripeCustomerId: string;
  stripeSubscriptionId: string;

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
  designFeedback: string;
  designRevisionCount: number;
  designProof: AirtableAttachment[];

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
  stripePriceId: string;
  trialDays: number;
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
  rosterApiUrl: string;
  rosterApiKey: string;
  rosterRefreshInterval: string;
  lastRosterSync: string;
  defaultCalendlyUrl: string;
  billingContact: string;
  notes: string;
  active: boolean;
  includesVoice: boolean;
  includesAvatar: boolean;
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
