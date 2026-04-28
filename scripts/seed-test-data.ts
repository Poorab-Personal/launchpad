/**
 * Test Data Seeding: Creates 21 D2C test customers at various onboarding stages.
 *
 * How it works:
 *   1. Creates customers with Channel="__SEED__" so Auto 1 can't find
 *      matching templates and fails silently (no duplicate tasks).
 *   2. Fetches REAL workflow templates from Airtable so task data stays current.
 *   3. Creates tasks directly with correct statuses for each customer's stage.
 *   4. Updates customers with the real Channel and all flag fields.
 *
 * RECOMMENDED: Disable Auto 1 ("New Customers -> Generate Tasks") and
 * Auto 2 ("Task Completed -> Activate Dependents") in Airtable BEFORE
 * running this script, then re-enable after. This avoids ~140 harmless
 * but noisy automation failures and error-notification emails.
 *
 * Usage:
 *   npx tsx scripts/seed-test-data.ts              # Clean + seed
 *   npx tsx scripts/seed-test-data.ts --clean-only  # Delete test records only
 *
 * Test customers identified by last name "Test" (e.g., "Sarah Test").
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const PAT = process.env.AIRTABLE_PAT!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;
const API = `https://api.airtable.com/v0/${BASE_ID}`;

if (!PAT || !BASE_ID) {
  console.error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID in .env.local');
  process.exit(1);
}

const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };
const args = process.argv.slice(2);
const cleanOnly = args.includes('--clean-only');

// ─── Rate Limiting ─────────────────────────────────────────────────

let lastReq = 0;
async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, 220 - (Date.now() - lastReq));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  return fn();
}

// ─── Airtable Helpers ──────────────────────────────────────────────

async function fetchAll(table: string, formula?: string): Promise<any[]> {
  const all: any[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${API}/${encodeURIComponent(table)}`);
    if (formula) url.searchParams.set('filterByFormula', formula);
    if (offset) url.searchParams.set('offset', offset);
    const res = await throttle(() => fetch(url.toString(), { headers: H }));
    if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...data.records);
    offset = data.offset;
  } while (offset);
  return all;
}

async function batchCreate(table: string, records: any[]): Promise<any[]> {
  const all: any[] = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const res = await throttle(() =>
      fetch(`${API}/${encodeURIComponent(table)}`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ records: chunk }),
      }),
    );
    if (!res.ok) throw new Error(`POST ${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...data.records);
  }
  return all;
}

async function batchUpdate(table: string, records: Array<{ id: string; fields: Record<string, unknown> }>): Promise<void> {
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const res = await throttle(() =>
      fetch(`${API}/${encodeURIComponent(table)}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({ records: chunk }),
      }),
    );
    if (!res.ok) throw new Error(`PATCH ${table}: ${res.status} ${await res.text()}`);
  }
}

async function batchDelete(table: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const params = chunk.map((id) => `records[]=${id}`).join('&');
    const res = await throttle(() =>
      fetch(`${API}/${encodeURIComponent(table)}?${params}`, { method: 'DELETE', headers: H }),
    );
    if (!res.ok) throw new Error(`DELETE ${table}: ${res.status} ${await res.text()}`);
  }
}

// ─── Date Helpers ──────────────────────────────────────────────────

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString();
}

function spreadTimestamps(count: number, startDaysAgo: number, endDaysAgo: number): string[] {
  if (count === 0) return [];
  const range = startDaysAgo - endDaysAgo;
  const step = range / (count + 1);
  return Array.from({ length: count }, (_, i) => daysAgo(startDaysAgo - step * (i + 1)));
}

// ─── Task Name Constants (match ACTUAL Airtable templates) ─────────

const C = {
  FORM: 'Complete Your Onboarding Form',
  DESIGNS: 'Create Designs',
  REVIEW_DESIGNS: 'Review Designs',
  PROOF: 'Upload Proof to Customer',
  BRAND_KIT: 'Review & Approve Your Brand Kit',
  CALL: 'Schedule Your Onboarding Call',
  MOVE: 'Move Designs to Production',
  ACCOUNT: 'Create Customer Account',
  CREDS: 'Send Credentials',
  VIDEO: 'Watch Setup Video',
  SIGNIN: 'Sign In & Reset Password',
  MARKCALL: 'Mark Onboarding Call Complete',
  FEEDBACK: 'Provide Onboarding Feedback',
  ZOOM: 'Send Zoom Recording',
  FOLLOWUP: 'Send Follow-Up Email',
  CHECKIN1: 'Schedule Check-In 1',
  CHECKIN2: 'Schedule Check-In 2',
};

const V = {
  SCRIPT: 'Download Script & Upload Recordings',
  CLONE: 'Create Voice Clone in ElevenLabs',
  WIRE: 'Wire Up Voice to Customer Account',
  NOTIFY: 'Notify Customer \u2014 Voice Ready',
};

const A = {
  GUIDE: 'Download Guide & Upload Videos',
  CLONE: 'Create Voice Clone in ElevenLabs',
  HEYGEN: 'Create Avatar in HeyGen',
  WIRE: 'Wire Up Avatar & Voice to Customer Account',
  NOTIFY: 'Notify Customer \u2014 Avatar Ready',
};

// CSM-assigned tasks (templates leave role blank since real flow assigns via Calendly)
const CSM_TASKS = new Set<string>([C.MARKCALL, C.ZOOM, C.FOLLOWUP]);

// Actual stage names (from current Airtable templates)
const STAGES = [
  'Getting Started',
  'Review Your Designs',
  'Prepare for Onboarding',
  'Onboarding Call',
  'Post Onboarding',
  'Review & Grow',
  'Done',
];

// ─── Types ─────────────────────────────────────────────────────────

type Status = 'Draft' | 'Active' | 'In Review' | 'Completed' | 'Rejected';

interface StatusMap {
  completed?: string[];
  active?: string[];
  inReview?: string[];
}

interface ExtraTask {
  name: string;
  stage: string;
  so: number;
  to: number;
  type: 'Client' | 'Team';
  vis: boolean;
  status: Status;
  dep: string;
  attach: string;
  instr: string;
  role: string | null;
  product: string;
  completedAt?: string;
  notes?: string;
}

interface CustDef {
  name: string;
  channel: string;
  email: string;
  tier: string;
  payment: string;
  stage: string;
  stageEnteredDaysAgo: number;
  createdDaysAgo: number;
  biz?: string;
  bio?: string;
  areas?: string;
  phone?: string;
  platEmail?: string;
  designApproval?: string;
  designFeedback?: string;
  designRevisionCount?: number;
  callBooked?: boolean;
  callDate?: string;
  callCompleted?: boolean;
  noShowCount?: number;
  accountCreated?: boolean;
  credentialsSent?: boolean;
  reminderCount?: number;
  hasVoice?: boolean;
  hasAvatar?: boolean;
  voiceStage?: string;
  avatarStage?: string;
  csm?: string;
  core: StatusMap;
  voice?: StatusMap;
  avatar?: StatusMap;
  extras?: ExtraTask[];
  taskNotes?: Record<string, string>;
}

// ─── 21 D2C Test Customers ─────────────────────────────────────────

const CUSTOMERS: CustDef[] = [
  // ── Stage 1: Getting Started ──────────────────────────────────────

  {
    name: 'Sarah Test', channel: 'Direct Sales', email: 'sarah.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Getting Started',
    stageEnteredDaysAgo: 1, createdDaysAgo: 1,
    biz: 'Sarah Chen Real Estate', areas: 'Miami, Coral Gables, Coconut Grove',
    phone: '(305) 555-0101',
    core: { active: [C.FORM] },
  },

  {
    name: 'Marcus Test', channel: 'Referral', email: 'marcus.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Getting Started',
    stageEnteredDaysAgo: 3, createdDaysAgo: 3,
    biz: 'Rivera Luxury Properties',
    bio: 'Luxury real estate specialist with 15 years of experience in Beverly Hills and Bel Air.',
    areas: 'Beverly Hills, Bel Air, Hollywood Hills', phone: '(310) 555-0202',
    hasVoice: true, voiceStage: 'Recording',
    core: { completed: [C.FORM], inReview: [C.DESIGNS] },
    voice: { active: [V.SCRIPT] },
  },

  {
    name: 'Priya Test', channel: 'Referral', email: 'priya.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Getting Started',
    stageEnteredDaysAgo: 2, createdDaysAgo: 2,
    biz: 'Priya Patel Homes', areas: 'Austin, Round Rock, Cedar Park',
    phone: '(512) 555-0303',
    hasAvatar: true, avatarStage: 'Recording',
    core: { completed: [C.FORM], active: [C.DESIGNS] },
    avatar: { active: [A.GUIDE] },
  },

  {
    name: 'Derek Test', channel: 'Webinar', email: 'derek.test@example.com',
    tier: 'Premium', payment: 'Waived', stage: 'Getting Started',
    stageEnteredDaysAgo: 9, createdDaysAgo: 9,
    reminderCount: 2,
    core: { active: [C.FORM] },
  },

  {
    name: 'Hannah Test', channel: 'Webinar', email: 'hannah.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Getting Started',
    stageEnteredDaysAgo: 5, createdDaysAgo: 5,
    biz: 'Hannah Park Realty',
    bio: 'Specializing in first-time homebuyers in the greater Portland area.',
    areas: 'Portland, Lake Oswego, Beaverton', phone: '(503) 555-0505',
    core: { completed: [C.FORM], active: [C.DESIGNS] },
    taskNotes: { [C.DESIGNS]: 'Revision needed: color palette doesn\'t match brand guidelines. Use warmer tones. (Rejected by Jigar)' },
  },

  // ── Stage 2: Review Your Designs ──────────────────────────────────

  {
    name: 'Jessica Test', channel: 'Direct Sales', email: 'jessica.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Review Your Designs',
    stageEnteredDaysAgo: 2, createdDaysAgo: 6,
    biz: 'Palmer & Associates Realty',
    bio: 'Award-winning agent serving the greater Chicago area for 10+ years.',
    areas: 'Chicago, Evanston, Oak Park, Naperville', phone: '(312) 555-0606',
    designApproval: 'Pending',
    core: { completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF], active: [C.BRAND_KIT] },
  },

  {
    name: 'David Test', channel: 'Standard', email: 'david.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Review Your Designs',
    stageEnteredDaysAgo: 4, createdDaysAgo: 8,
    biz: 'Nguyen Premier Properties',
    bio: 'Luxury specialist in Dallas-Fort Worth with a background in architecture.',
    areas: 'Dallas, Fort Worth, Frisco, Plano', phone: '(214) 555-0707',
    designApproval: 'Changes Requested',
    designFeedback: 'Love the overall direction! For round 2: can you make the logo slightly larger and use a deeper navy blue? Also, the headshot crop feels too tight.',
    designRevisionCount: 2,
    core: { completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF], active: [C.BRAND_KIT] },
    extras: [
      { name: 'Revise Design (Round 1)', stage: 'Review Your Designs', so: 2, to: 10, type: 'Team', vis: false, status: 'Completed', dep: '', attach: 'None', instr: 'Revise designs based on customer feedback (round 1).', role: 'Designer', product: 'Core', completedAt: daysAgo(5) },
      { name: 'Review Revision (Round 1)', stage: 'Review Your Designs', so: 2, to: 11, type: 'Team', vis: false, status: 'Completed', dep: 'Revise Design (Round 1)', attach: 'None', instr: 'Review revised designs (round 1).', role: 'Senior Designer', product: 'Core', completedAt: daysAgo(4.5) },
      { name: 'Upload Revised Proof (Round 1)', stage: 'Review Your Designs', so: 2, to: 12, type: 'Team', vis: false, status: 'Completed', dep: 'Review Revision (Round 1)', attach: 'None', instr: 'Upload revised proof for customer review (round 1).', role: 'Designer', product: 'Core', completedAt: daysAgo(4) },
      { name: 'Revise Design (Round 2)', stage: 'Review Your Designs', so: 2, to: 13, type: 'Team', vis: false, status: 'Active', dep: '', attach: 'None', instr: 'Revise designs based on round 2 feedback.', role: 'Designer', product: 'Core' },
      { name: 'Review Revision (Round 2)', stage: 'Review Your Designs', so: 2, to: 14, type: 'Team', vis: false, status: 'Draft', dep: 'Revise Design (Round 2)', attach: 'None', instr: 'Review revised designs (round 2).', role: 'Senior Designer', product: 'Core' },
      { name: 'Upload Revised Proof (Round 2)', stage: 'Review Your Designs', so: 2, to: 15, type: 'Team', vis: false, status: 'Draft', dep: 'Review Revision (Round 2)', attach: 'None', instr: 'Upload revised proof for customer review (round 2).', role: 'Designer', product: 'Core' },
    ],
  },

  {
    name: 'Aisha Test', channel: 'Referral', email: 'aisha.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Review Your Designs',
    stageEnteredDaysAgo: 1, createdDaysAgo: 9,
    biz: 'Johnson Premier Homes',
    bio: 'Certified luxury home specialist in the Atlanta metropolitan area.',
    areas: 'Atlanta, Buckhead, Decatur, Marietta', phone: '(404) 555-0808',
    designApproval: 'Approved',
    hasVoice: true, voiceStage: 'Setup',
    hasAvatar: true, avatarStage: 'Recording',
    core: { completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT], active: [C.CALL] },
    voice: { completed: [V.SCRIPT, V.CLONE], active: [V.WIRE] },
    avatar: { active: [A.GUIDE] },
  },

  // ── Stage 3: Prepare for Onboarding ───────────────────────────────

  {
    name: 'Carlos Test', channel: 'Standard', email: 'carlos.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Prepare for Onboarding',
    stageEnteredDaysAgo: 2, createdDaysAgo: 10,
    biz: 'Mendez Coastal Properties',
    bio: 'Specializing in coastal and waterfront properties from San Diego to La Jolla.',
    areas: 'San Diego, La Jolla, Del Mar, Coronado', phone: '(619) 555-0909',
    designApproval: 'Approved',
    hasAvatar: true, avatarStage: 'Setup',
    core: { completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE], active: [C.ACCOUNT] },
    avatar: { completed: [A.GUIDE], active: [A.CLONE, A.HEYGEN] },
  },

  {
    name: 'Amanda Test', channel: 'Direct Sales', email: 'amanda.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Prepare for Onboarding',
    stageEnteredDaysAgo: 3, createdDaysAgo: 11,
    biz: 'Brooks Realty Group',
    bio: 'Full-service real estate team in Denver, helping families find their perfect home.',
    areas: 'Denver, Boulder, Aurora, Lakewood', phone: '(720) 555-1010',
    platEmail: 'amanda@brooksrealty.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    hasVoice: true, voiceStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS],
      active: [C.VIDEO, C.SIGNIN],
    },
    voice: { completed: [V.SCRIPT, V.CLONE, V.WIRE], active: [V.NOTIFY] },
  },

  {
    name: 'Mei Lin Test', channel: 'Standard', email: 'meilin.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Prepare for Onboarding',
    stageEnteredDaysAgo: 1, createdDaysAgo: 11,
    biz: 'Zhang Properties',
    bio: 'Bilingual agent (English/Mandarin) specializing in San Francisco Bay Area real estate.',
    areas: 'San Francisco, Palo Alto, Sunnyvale, Fremont', phone: '(415) 555-1212',
    platEmail: 'meilin@zhangproperties.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callDate: daysFromNow(1), csm: 'luis',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO],
      active: [C.SIGNIN],
    },
  },

  // ── Stage 4: Onboarding Call ──────────────────────────────────────

  {
    name: 'Tyler Test', channel: 'Standard', email: 'tyler.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Onboarding Call',
    stageEnteredDaysAgo: 2, createdDaysAgo: 12,
    biz: 'Washington & Associates',
    bio: 'Commercial and residential real estate expert in the DC metro area.',
    areas: 'Washington DC, Arlington, Bethesda, Alexandria', phone: '(202) 555-1111',
    platEmail: 'tyler@washingtonassoc.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callDate: daysFromNow(3), csm: 'mario',
    hasVoice: true, voiceStage: 'Activation',
    hasAvatar: true, avatarStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN],
      active: [C.MARKCALL],
    },
    voice: { completed: [V.SCRIPT, V.CLONE, V.WIRE, V.NOTIFY] },
    avatar: { completed: [A.GUIDE, A.CLONE, A.HEYGEN, A.WIRE], active: [A.NOTIFY] },
  },

  {
    name: 'Olivia Test', channel: 'Direct Sales', email: 'olivia.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Onboarding Call',
    stageEnteredDaysAgo: 3, createdDaysAgo: 13,
    biz: 'Olivia Reed Properties',
    bio: 'Helping families find their dream home in the Phoenix valley.',
    areas: 'Phoenix, Scottsdale, Tempe, Mesa', phone: '(480) 555-1313',
    platEmail: 'olivia@reedproperties.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, noShowCount: 1, csm: 'mario',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN],
      active: [C.MARKCALL],
    },
    taskNotes: { [C.MARKCALL]: 'No-show on original call date. Reschedule task created.' },
    extras: [
      { name: 'Reschedule Your Onboarding Call', stage: 'Onboarding Call', so: 4, to: 10, type: 'Client', vis: true, status: 'Active', dep: '', attach: 'Embed', instr: 'We missed you! Please reschedule your onboarding call at a time that works.', role: null, product: 'Core' },
    ],
  },

  // ── Stage 5: Post Onboarding ──────────────────────────────────────

  {
    name: 'Lisa Test', channel: 'Webinar', email: 'lisa.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Post Onboarding',
    stageEnteredDaysAgo: 1, createdDaysAgo: 14,
    biz: 'Fernandez Home Group',
    bio: 'Top-producing team leader in Houston, helping clients navigate the Texas real estate market.',
    areas: 'Houston, Sugar Land, Katy, The Woodlands', phone: '(713) 555-1414',
    platEmail: 'lisa@fernandezhomes.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'mario',
    hasVoice: true, voiceStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL],
      active: [C.FEEDBACK, C.ZOOM, C.FOLLOWUP],
    },
    voice: { completed: [V.SCRIPT, V.CLONE, V.WIRE, V.NOTIFY] },
  },

  {
    name: 'James Test', channel: 'Webinar', email: 'james.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Post Onboarding',
    stageEnteredDaysAgo: 2, createdDaysAgo: 15,
    biz: 'Cooper & Sons Real Estate',
    bio: 'Third-generation real estate family serving the greater Nashville area.',
    areas: 'Nashville, Franklin, Murfreesboro, Hendersonville', phone: '(615) 555-1515',
    platEmail: 'james@cooperandsons.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'luis',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.ZOOM],
      active: [C.FEEDBACK, C.FOLLOWUP],
    },
  },

  {
    name: 'Nina Test', channel: 'Direct Sales', email: 'nina.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Post Onboarding',
    stageEnteredDaysAgo: 3, createdDaysAgo: 17,
    biz: 'Petrova Real Estate',
    bio: 'Multilingual agent (English, Russian, Ukrainian) serving the Charlotte metro area.',
    areas: 'Charlotte, Huntersville, Concord, Matthews', phone: '(704) 555-1616',
    platEmail: 'nina@petrovarealestate.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'mario',
    hasVoice: true, voiceStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.ZOOM, C.FOLLOWUP],
      active: [C.FEEDBACK],
    },
    voice: { completed: [V.SCRIPT, V.CLONE, V.WIRE, V.NOTIFY] },
  },

  // ── Stage 6: Review & Grow ────────────────────────────────────────

  {
    name: 'Ryan Test', channel: 'Referral', email: 'ryan.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Review & Grow',
    stageEnteredDaysAgo: 3, createdDaysAgo: 18,
    biz: "O'Brien Real Estate Group",
    bio: 'Helping families find homes in the Pacific Northwest since 2008.',
    areas: 'Seattle, Bellevue, Redmond, Kirkland', phone: '(206) 555-1717',
    platEmail: 'ryan@obrienrealty.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'luis',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.FEEDBACK, C.ZOOM, C.FOLLOWUP],
      active: [C.CHECKIN1],
    },
  },

  {
    name: 'Robert Test', channel: 'Standard', email: 'robert.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Review & Grow',
    stageEnteredDaysAgo: 5, createdDaysAgo: 20,
    biz: 'Kim Premier Realty',
    bio: 'Specializing in luxury condos and high-rises in Manhattan and Brooklyn.',
    areas: 'Manhattan, Brooklyn, Long Island City, Hoboken', phone: '(212) 555-1818',
    platEmail: 'robert@kimpremier.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'luis',
    hasAvatar: true, avatarStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.FEEDBACK, C.ZOOM, C.FOLLOWUP, C.CHECKIN1],
      active: [C.CHECKIN2],
    },
    avatar: { completed: [A.GUIDE, A.CLONE, A.HEYGEN, A.WIRE, A.NOTIFY] },
  },

  // ── Done ──────────────────────────────────────────────────────────

  {
    name: 'Elena Test', channel: 'Direct Sales', email: 'elena.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Done',
    stageEnteredDaysAgo: 1, createdDaysAgo: 21,
    biz: 'Martinez Dream Homes',
    bio: 'Bilingual agent (English/Spanish) making the dream of homeownership a reality in South Florida.',
    areas: 'Fort Lauderdale, Boca Raton, West Palm Beach', phone: '(954) 555-1919',
    platEmail: 'elena@martinezhomes.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'mario',
    hasVoice: true, voiceStage: 'Activation',
    hasAvatar: true, avatarStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.FEEDBACK, C.ZOOM, C.FOLLOWUP, C.CHECKIN1, C.CHECKIN2],
    },
    voice: { completed: [V.SCRIPT, V.CLONE, V.WIRE, V.NOTIFY] },
    avatar: { completed: [A.GUIDE, A.CLONE, A.HEYGEN, A.WIRE, A.NOTIFY] },
  },

  {
    name: 'Kevin Test', channel: 'Standard', email: 'kevin.test@example.com',
    tier: 'Luxury', payment: 'Paid', stage: 'Done',
    stageEnteredDaysAgo: 3, createdDaysAgo: 28,
    biz: 'Thompson Real Estate Co.',
    bio: 'Commercial and residential real estate broker in the greater Minneapolis area.',
    areas: 'Minneapolis, St. Paul, Bloomington, Eden Prairie', phone: '(612) 555-2020',
    platEmail: 'kevin@thompsonrealestate.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'luis',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.FEEDBACK, C.ZOOM, C.FOLLOWUP, C.CHECKIN1, C.CHECKIN2],
    },
  },

  {
    name: 'Sophie Test', channel: 'Referral', email: 'sophie.test@example.com',
    tier: 'Premium', payment: 'Paid', stage: 'Done',
    stageEnteredDaysAgo: 2, createdDaysAgo: 18,
    biz: 'Sophie Laurent Realty',
    bio: 'French-American agent bringing a global perspective to luxury real estate in Miami Beach.',
    areas: 'Miami Beach, South Beach, Key Biscayne, Bal Harbour', phone: '(786) 555-2121',
    platEmail: 'sophie@laurentrealty.com',
    designApproval: 'Approved', accountCreated: true, credentialsSent: true,
    callBooked: true, callCompleted: true, csm: 'mario',
    hasVoice: true, voiceStage: 'Activation',
    core: {
      completed: [C.FORM, C.DESIGNS, C.REVIEW_DESIGNS, C.PROOF, C.BRAND_KIT, C.CALL, C.MOVE, C.ACCOUNT, C.CREDS, C.VIDEO, C.SIGNIN, C.MARKCALL, C.FEEDBACK, C.ZOOM, C.FOLLOWUP, C.CHECKIN1, C.CHECKIN2],
    },
    voice: { completed: [V.SCRIPT, V.CLONE, V.WIRE, V.NOTIFY] },
  },
];

// ─── Builders ──────────────────────────────────────────────────────

function resolveStatus(name: string, map: StatusMap): Status {
  if (map.completed?.includes(name)) return 'Completed';
  if (map.active?.includes(name)) return 'Active';
  if (map.inReview?.includes(name)) return 'In Review';
  return 'Draft';
}

/** Build task records from Airtable template records, applying status overrides */
function buildTasksFromTemplates(
  templates: any[],
  statusMap: StatusMap,
  product: string,
  custId: string,
  def: CustDef,
  teamByRole: Record<string, string>,
  csms: Record<string, string>,
): Array<{ fields: Record<string, unknown> }> {
  const completed = statusMap.completed || [];
  const timestamps = spreadTimestamps(completed.length, def.createdDaysAgo, def.stageEnteredDaysAgo);
  const completedAt: Record<string, string> = {};
  completed.forEach((name, i) => { completedAt[name] = timestamps[i]; });

  return templates.map((tmpl) => {
    const tf = tmpl.fields;
    const taskName = (tf['Task Title'] as string) || '';
    const status = resolveStatus(taskName, statusMap);

    const f: Record<string, unknown> = {
      'Task Name': taskName,
      Customer: [custId],
      'Task Type': tf['Task Type'] || 'Client',
      Stage: tf['Stage'] || '',
      'Stage Order': tf['Stage Order'] || 0,
      'Task Order': tf['Task Order'] || 0,
      Status: status,
      'Visible To Client': tf['Visible To Client'] || false,
      'Has Team Review': tf['Has Team Review'] || false,
      'Attachment Type': tf['Attachment Type'] || 'None',
      Product: product,
    };

    if (tf['Depends On']) f['Depends On'] = tf['Depends On'];
    if (tf['Instructions']) f['Instructions'] = tf['Instructions'];
    if (tf['Embed URL']) f['Embed URL'] = tf['Embed URL'];

    // Assign team member
    const role = (tf['Assigned Role'] as string) || '';
    let memberId: string | undefined;
    if (role) {
      memberId = role === 'CSM' ? (def.csm ? csms[def.csm] : undefined) : teamByRole[role];
    } else if (tf['Task Type'] === 'Team' && CSM_TASKS.has(taskName) && def.csm) {
      // Templates leave Assigned Role blank for CSM tasks (assigned via Calendly in real flow).
      // For test data, fall back to the customer's assigned CSM.
      memberId = csms[def.csm];
    }
    if (memberId) f['Assigned To'] = [memberId];

    if (status === 'Completed' && completedAt[taskName]) {
      f['Completed At'] = completedAt[taskName];
    }

    const notes = def.taskNotes?.[taskName];
    if (notes) f['Notes'] = notes;

    return { fields: f };
  });
}

function buildExtraTaskRecords(
  def: CustDef,
  custId: string,
  teamByRole: Record<string, string>,
  csms: Record<string, string>,
): Array<{ fields: Record<string, unknown> }> {
  if (!def.extras) return [];
  return def.extras.map((ex) => {
    const f: Record<string, unknown> = {
      'Task Name': ex.name,
      Customer: [custId],
      'Task Type': ex.type,
      Stage: ex.stage,
      'Stage Order': ex.so,
      'Task Order': ex.to,
      Status: ex.status,
      'Visible To Client': ex.vis,
      'Has Team Review': false,
      'Attachment Type': ex.attach,
      Product: ex.product,
    };
    if (ex.dep) f['Depends On'] = ex.dep;
    if (ex.instr) f['Instructions'] = ex.instr;
    if (ex.completedAt) f['Completed At'] = ex.completedAt;
    if (ex.notes) f['Notes'] = ex.notes;
    const role = ex.role;
    if (role) {
      const memberId = role === 'CSM' ? (def.csm ? csms[def.csm] : undefined) : teamByRole[role];
      if (memberId) f['Assigned To'] = [memberId];
    }
    return { fields: f };
  });
}

function buildEventRecords(def: CustDef, custId: string): Array<{ fields: Record<string, unknown> }> {
  const records: Array<{ fields: Record<string, unknown> }> = [];
  function evt(type: string, actor: string, details: string) {
    records.push({ fields: { Customer: [custId], 'Event Type': type, 'Actor Type': actor, Details: details } });
  }

  const addons = [def.hasVoice && 'Voice', def.hasAvatar && 'Avatar'].filter(Boolean);
  const addonSuffix = addons.length ? ` Add-ons: ${addons.join(', ')}.` : '';
  evt('Customer Created', 'System', `D2C customer created via ${def.channel}. ${def.tier} tier.${addonSuffix}`);

  const idx = STAGES.indexOf(def.stage);
  for (let i = 1; i <= idx; i++) evt('Stage Changed', 'System', `Advanced from "${STAGES[i - 1]}" to "${STAGES[i]}".`);

  if (def.designApproval === 'Approved') evt('Design Approved', 'Customer', 'Customer approved brand kit.');
  if (def.designApproval === 'Changes Requested') {
    for (let i = 1; i <= (def.designRevisionCount || 1); i++) evt('Design Changes Requested', 'Customer', `Customer requested design changes (round ${i}).`);
  }
  if (def.taskNotes?.[C.DESIGNS]?.includes('Rejected')) {
    evt('Task Sent to Review', 'Team Member', `"${C.DESIGNS}" submitted for senior review.`);
    evt('Task Rejected', 'Team Member', `"${C.DESIGNS}" rejected by senior designer.`);
  }
  if (def.core.inReview?.includes(C.DESIGNS)) evt('Task Sent to Review', 'Team Member', `"${C.DESIGNS}" submitted for senior review.`);
  if (def.accountCreated) evt('Account Created', 'System', 'Customer account created in app.rejig.ai.');
  if (def.credentialsSent) evt('Credentials Sent', 'System', 'Login credentials sent to customer.');
  if (def.callBooked) evt('Call Booked', 'Customer', 'Onboarding call booked.');
  if (def.callCompleted) evt('Call Completed', 'Team Member', 'Onboarding call completed successfully.');
  if (def.noShowCount) {
    for (let i = 1; i <= def.noShowCount; i++) evt('Stage Changed', 'System', `No-show for onboarding call (occurrence ${i}). Reschedule task created.`);
  }
  if (def.reminderCount) {
    for (let i = 1; i <= def.reminderCount; i++) evt('Reminder Sent', 'System', `Reminder ${i} sent — onboarding form stalled.`);
  }

  return records;
}

// ─── Cleanup ───────────────────────────────────────────────────────

async function cleanup() {
  console.log('\n--- Cleaning up test data ---\n');

  const allCustomers = await fetchAll('Customers');
  const testCustomers = allCustomers.filter((r) => ((r.fields.Name as string) || '').endsWith(' Test'));

  if (testCustomers.length === 0) {
    console.log('  No test customers found.\n');
    return;
  }

  const custIds = new Set(testCustomers.map((r: any) => r.id));
  console.log(`  Found ${testCustomers.length} test customers.`);

  const allEvents = await fetchAll('Events');
  const eventIds = allEvents.filter((r: any) => {
    const linked = (r.fields.Customer as any[]) || [];
    return linked.some((l: any) => custIds.has(typeof l === 'string' ? l : l.id));
  }).map((r: any) => r.id);
  if (eventIds.length > 0) { console.log(`  Deleting ${eventIds.length} events...`); await batchDelete('Events', eventIds); }

  const allTasks = await fetchAll('Tasks');
  const taskIds = allTasks.filter((r: any) => {
    const linked = (r.fields.Customer as any[]) || [];
    return linked.some((l: any) => custIds.has(typeof l === 'string' ? l : l.id));
  }).map((r: any) => r.id);
  if (taskIds.length > 0) { console.log(`  Deleting ${taskIds.length} tasks...`); await batchDelete('Tasks', taskIds); }

  console.log(`  Deleting ${testCustomers.length} customers...`);
  await batchDelete('Customers', testCustomers.map((r: any) => r.id));
  console.log('  Cleanup complete.\n');
}

// ─── Seed ──────────────────────────────────────────────────────────

async function seed() {
  console.log('\n--- Seeding 21 test customers ---\n');

  // 1. Fetch team members
  const teamRecords = await fetchAll('Team Members');
  const teamByRole: Record<string, string> = {};
  const csms: Record<string, string> = {};
  for (const r of teamRecords) {
    const name = (r.fields.Name as string) || '';
    const role = (r.fields.Role as string) || '';
    if (r.fields.Default === true && role && role !== 'CSM') teamByRole[role] = r.id;
    if (role === 'CSM') csms[name.toLowerCase()] = r.id;
  }
  console.log(`  Team roles: ${Object.keys(teamByRole).join(', ')}`);
  console.log(`  CSMs: ${Object.keys(csms).join(', ')}`);

  // 2. Fetch REAL workflow templates from Airtable
  const allTemplates = await fetchAll('Workflow Templates');
  const coreTemplates = allTemplates
    .filter((r) => r.fields['Workflow Key'] === 'D2C-Standard')
    .sort((a: any, b: any) => ((a.fields['Stage Order'] || 0) - (b.fields['Stage Order'] || 0)) || ((a.fields['Task Order'] || 0) - (b.fields['Task Order'] || 0)));
  const voiceTemplates = allTemplates
    .filter((r) => r.fields['Workflow Key'] === 'Addon-Voice')
    .sort((a: any, b: any) => ((a.fields['Stage Order'] || 0) - (b.fields['Stage Order'] || 0)) || ((a.fields['Task Order'] || 0) - (b.fields['Task Order'] || 0)));
  const avatarTemplates = allTemplates
    .filter((r) => r.fields['Workflow Key'] === 'Addon-Avatar')
    .sort((a: any, b: any) => ((a.fields['Stage Order'] || 0) - (b.fields['Stage Order'] || 0)) || ((a.fields['Task Order'] || 0) - (b.fields['Task Order'] || 0)));

  console.log(`  Templates: ${coreTemplates.length} Core, ${voiceTemplates.length} Voice, ${avatarTemplates.length} Avatar\n`);

  let totalTasks = 0;
  let totalEvents = 0;
  const portalUrls: Array<{ name: string; stage: string; url: string }> = [];

  for (const def of CUSTOMERS) {
    process.stdout.write(`  ${def.name} [${def.stage}]`);

    // 3a. Create customer with Channel="__SEED__" so Auto 1 can't find templates
    const initFields: Record<string, unknown> = {
      Name: def.name,
      Type: 'D2C',
      Channel: '__SEED__',
      'Contact Email': def.email,
    };
    if (def.hasVoice) initFields['Has Voice'] = true;
    if (def.hasAvatar) initFields['Has Avatar'] = true;

    const [custRecord] = await batchCreate('Customers', [{ fields: initFields }]);
    const custId = custRecord.id;

    // 3b. Create tasks from REAL templates
    const coreTasks = buildTasksFromTemplates(coreTemplates, def.core, 'Core', custId, def, teamByRole, csms);
    const voiceTasks = def.hasVoice && def.voice ? buildTasksFromTemplates(voiceTemplates, def.voice, 'Voice', custId, def, teamByRole, csms) : [];
    const avatarTasks = def.hasAvatar && def.avatar ? buildTasksFromTemplates(avatarTemplates, def.avatar, 'Avatar', custId, def, teamByRole, csms) : [];
    const extraTasks = buildExtraTaskRecords(def, custId, teamByRole, csms);

    const allTaskRecords = [...coreTasks, ...voiceTasks, ...avatarTasks, ...extraTasks];
    await batchCreate('Tasks', allTaskRecords);
    totalTasks += allTaskRecords.length;

    // 3c. Update customer with real Channel and all fields
    const update: Record<string, unknown> = {
      Channel: def.channel,
      'Product Tier': def.tier,
      'Payment Status': def.payment,
      'Current Stage': def.stage,
      'Stage Entered At': daysAgo(def.stageEnteredDaysAgo),
    };
    if (def.biz) update['Business Name'] = def.biz;
    if (def.bio) update['Bio'] = def.bio;
    if (def.areas) update['Service Areas'] = def.areas;
    if (def.phone) update['Phone'] = def.phone;
    if (def.platEmail) update['Platform Email'] = def.platEmail;
    if (def.designApproval) update['Design Approval'] = def.designApproval;
    if (def.designFeedback) update['Design Feedback'] = def.designFeedback;
    if (def.designRevisionCount) update['Design Revision Count'] = def.designRevisionCount;
    if (def.callBooked) update['Call Booked'] = true;
    if (def.callDate) update['Call Date'] = def.callDate;
    if (def.callCompleted) update['Call Completed'] = true;
    if (def.noShowCount) update['No Show Count'] = def.noShowCount;
    if (def.accountCreated) update['Account Created'] = true;
    if (def.credentialsSent) update['Credentials Sent'] = true;
    if (def.reminderCount) update['Reminder Count'] = def.reminderCount;
    if (def.voiceStage) update['Voice Stage'] = def.voiceStage;
    if (def.avatarStage) update['Avatar Stage'] = def.avatarStage;
    if (def.csm && csms[def.csm]) update['CSM Assigned'] = [csms[def.csm]];

    await batchUpdate('Customers', [{ id: custId, fields: update }]);

    // 3d. Create events
    const eventRecords = buildEventRecords(def, custId);
    await batchCreate('Events', eventRecords);
    totalEvents += eventRecords.length;

    process.stdout.write(` -> ${allTaskRecords.length} tasks, ${eventRecords.length} events\n`);
    portalUrls.push({ name: def.name, stage: def.stage, url: `/r/${custId}` });
  }

  console.log('\n--- Seeding complete ---\n');
  console.log(`  Customers: ${CUSTOMERS.length}`);
  console.log(`  Tasks:     ${totalTasks}`);
  console.log(`  Events:    ${totalEvents}`);
  console.log('\n--- Portal URLs ---\n');
  for (const { name, stage, url } of portalUrls) {
    console.log(`  ${name.padEnd(18)} ${stage.padEnd(28)} ${url}`);
  }
  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== LaunchPad Test Data Seeder ===');
  await cleanup();
  if (!cleanOnly) {
    await seed();
  }
}

main().catch((err) => {
  console.error('\nFailed:', err);
  process.exit(1);
});
