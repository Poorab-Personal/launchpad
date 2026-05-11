/**
 * Stripe webhook integration tests.
 *
 * Architect-mandated regression net. Originally targeted the Airtable-backed
 * route (Phase 1.5); since Phase 2.2 the route imports from @/lib/db, so
 * this suite now exercises the Postgres-backed implementation.
 *
 * Mocking strategy:
 *   - Mock @/lib/db at the named-function level (getCustomers, etc.)
 *   - Real stripe.webhooks.constructEvent (signature verifier) runs
 *   - Signed payloads built via stripe.webhooks.generateTestHeaderString
 *   - Drizzle is never actually connected — fake POSTGRES_URL satisfies the
 *     guard in src/db/index.ts but the connection is never used because
 *     every consumer of `db` from db.ts is vi.mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import type { Customer, Task } from '@/types';

// vi.mock hoists above imports.
vi.mock('@/lib/db', () => ({
  getCustomers: vi.fn(),
  getTasksForCustomer: vi.fn(),
  updateCustomerFields: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

import * as dbLayer from '@/lib/db';
import { POST } from '@/app/api/webhooks/stripe/route';
import type { NextRequest } from 'next/server';

const WEBHOOK_SECRET = 'whsec_test_secret_phase15_vitest';
const stripe = new Stripe('sk_test_dummy_phase15_vitest');

// ---- Fixtures ------------------------------------------------------------

function makeCustomer(opts: {
  id?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  tasks?: string[];
} = {}): Customer {
  return {
    id: opts.id ?? 'recCust1',
    name: 'Test Agent',
    type: 'D2C',
    channel: 'Standard',
    workflowKey: 'D2C-Standard',
    contactEmail: 'test@example.com',
    platformEmail: 'test@example.com',
    phone: '',
    businessName: '',
    businessAddress: '',
    website: '',
    serviceAreas: '',
    localContentAreas: '',
    bio: '',
    licenseNumber: '',
    topics: '',
    hashtags: '',
    gmbName: '',
    mlsIds: '',
    specialInstructions: '',
    agentPhoto: [],
    businessLogo: [],
    otherAssets: [],
    hasVoice: false,
    hasAvatar: false,
    voiceStage: '',
    avatarStage: '',
    voiceStripeId: '',
    avatarStripeId: '',
    hubspotDealId: '',
    stripePaymentId: '',
    addOnStripePaymentId: '',
    productTier: null,
    paymentStatus: null,
    brokerage: [],
    rosterRecord: [],
    csmAssigned: [],
    designApproval: null,
    designFeedback: '',
    designRevisionCount: 0,
    designProof: [],
    designDrafts: [],
    designProofsUpdatedAt: '',
    currentStage: 'Getting Started',
    stageEnteredAt: '',
    accountCreated: false,
    credentialsSent: false,
    callBooked: false,
    callCompleted: false,
    callDate: '',
    noShowCount: 0,
    otherEmails: '',
    stripeCustomerId: opts.stripeCustomerId ?? '',
    stripeSubscriptionId: opts.stripeSubscriptionId ?? '',
    selectedStripePriceId: '',
    selectedPlanName: '',
    atRisk: false,
    atRiskReason: null,
    accessToken: 'tok_test',
    environment: [],
    portalBaseUrl: '',
    tasks: opts.tasks ?? [],
    events: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastModified: '2026-01-01T00:00:00.000Z',
  };
}

function makeTask(opts: { id?: string; taskName: string; status: Task['status']; customerId?: string }): Task {
  return {
    id: opts.id ?? 'recTask1',
    taskName: opts.taskName,
    customer: [opts.customerId ?? 'recCust1'],
    taskType: 'Client',
    stage: 'Getting Started',
    status: opts.status,
    taskOrder: 1,
    stageOrder: 1,
    assignedTo: [],
    visibleToClient: true,
    dependsOn: '',
    hasTeamReview: false,
    attachmentType: 'None',
    embedUrl: '',
    instructions: '',
    tags: [],
    notes: '',
    dueDate: '',
    completedAt: '',
    activatedAt: '',
    daysActive: null,
    lastReminderAt: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    product: 'Core',
  };
}

// Stripe.Event JSON builder — verifier doesn't validate inner shape; the
// route reads .type, .id, and the nested .data.object.{customer, id, status}.
function setupIntentEvent(opts: { customerId: string | null; eventId?: string }) {
  return {
    id: opts.eventId ?? 'evt_test_si_1',
    object: 'event' as const,
    type: 'setup_intent.succeeded' as const,
    api_version: '2024-12-18.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: { id: 'seti_test_1', object: 'setup_intent', customer: opts.customerId, status: 'succeeded' },
    },
  };
}

function subscriptionEvent(opts: {
  type: 'created' | 'updated' | 'deleted';
  customerId: string | null;
  subId: string;
  status: string;
  eventId?: string;
}) {
  return {
    id: opts.eventId ?? `evt_test_sub_${opts.type}`,
    object: 'event' as const,
    type: `customer.subscription.${opts.type}` as const,
    api_version: '2024-12-18.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: { id: opts.subId, object: 'subscription', customer: opts.customerId, status: opts.status },
    },
  };
}

function makeSignedRequest(
  payload: object,
  opts?: { secret?: string; skipSignature?: boolean; badSignature?: boolean },
): NextRequest {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts?.skipSignature) {
    headers['stripe-signature'] = opts?.badSignature
      ? 't=0,v1=deadbeef'
      : stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: opts?.secret ?? WEBHOOK_SECRET,
        });
  }
  return new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers, body }) as unknown as NextRequest;
}

// ---- Mock helpers --------------------------------------------------------

const mockGetCustomers = vi.mocked(dbLayer.getCustomers);
const mockGetTasksForCustomer = vi.mocked(dbLayer.getTasksForCustomer);
const mockUpdateCustomerFields = vi.mocked(dbLayer.updateCustomerFields);
const mockUpdateTaskStatus = vi.mocked(dbLayer.updateTaskStatus);

beforeEach(() => {
  vi.clearAllMocks();
  // updateCustomerFields returns the updated Customer; default to echoing one.
  mockUpdateCustomerFields.mockResolvedValue(makeCustomer());
  mockUpdateTaskStatus.mockResolvedValue(
    makeTask({ taskName: 'Capture Payment Method', status: 'Completed' }),
  );
});

// ---- Tests ---------------------------------------------------------------

describe('signature verification', () => {
  it('returns 200 for a validly-signed event (no matching customer = no-op)', async () => {
    mockGetCustomers.mockResolvedValue([]);
    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_no_match' }));

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('returns 400 "Invalid signature" for a malformed signature', async () => {
    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_x' }), {
      badSignature: true,
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid signature');
    expect(mockUpdateCustomerFields).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it('returns 400 "Missing signature" when the header is absent', async () => {
    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_x' }), {
      skipSignature: true,
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Missing signature');
  });

  it('returns 500 "Webhook not configured" when STRIPE_WEBHOOK_SECRET is unset', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_x' }));
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Webhook not configured' });
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});

describe('setup_intent.succeeded', () => {
  it('marks Capture Payment Method task Completed when Active', async () => {
    const customer = makeCustomer({ id: 'recCustA', stripeCustomerId: 'cus_test_A', tasks: ['recTaskA'] });
    const task = makeTask({ id: 'recTaskA', taskName: 'Capture Payment Method', status: 'Active' });
    mockGetCustomers.mockResolvedValue([customer]);
    mockGetTasksForCustomer.mockResolvedValue([task]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_test_A' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).toHaveBeenCalledExactlyOnceWith('recTaskA', 'Completed');
  });

  it('is a no-op when Capture Payment Method task is already Completed', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_B', tasks: ['recTask1'] });
    const task = makeTask({ taskName: 'Capture Payment Method', status: 'Completed' });
    mockGetCustomers.mockResolvedValue([customer]);
    mockGetTasksForCustomer.mockResolvedValue([task]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_test_B' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it('is a no-op when no Customer matches the Stripe customer id', async () => {
    mockGetCustomers.mockResolvedValue([]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_nobody' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it('is a no-op when setupIntent has no customer', async () => {
    const req = makeSignedRequest(setupIntentEvent({ customerId: null }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockGetCustomers).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it('is a no-op when customer has no Capture Payment Method task', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_C', tasks: ['recOther'] });
    const otherTask = makeTask({ taskName: 'Schedule Your Onboarding Call', status: 'Active' });
    mockGetCustomers.mockResolvedValue([customer]);
    mockGetTasksForCustomer.mockResolvedValue([otherTask]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_test_C' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.created', () => {
  it('writes Stripe Subscription ID + Subscription Status=Trial for status=trialing', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_D' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'created', customerId: 'cus_test_D', subId: 'sub_test_1', status: 'trialing' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).toHaveBeenCalledExactlyOnceWith(customer.id, {
      stripeSubscriptionId: 'sub_test_1',
      subscriptionStatus: 'Trial',
    });
  });

  it('writes Subscription Status=Active for status=active', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_E' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'created', customerId: 'cus_test_E', subId: 'sub_test_2', status: 'active' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).toHaveBeenCalledExactlyOnceWith(customer.id, {
      stripeSubscriptionId: 'sub_test_2',
      subscriptionStatus: 'Active',
    });
  });

  it('is a no-op when no matching customer is found', async () => {
    mockGetCustomers.mockResolvedValue([]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'created', customerId: 'cus_nobody', subId: 'sub_x', status: 'active' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.updated', () => {
  it('updates Subscription Status on trial→active transition', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_F', stripeSubscriptionId: 'sub_test_3' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'updated', customerId: 'cus_test_F', subId: 'sub_test_3', status: 'active' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).toHaveBeenCalledExactlyOnceWith(customer.id, {
      stripeSubscriptionId: 'sub_test_3',
      subscriptionStatus: 'Active',
    });
  });

  it('writes Subscription Status=Past Due for status=past_due', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_G' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'updated', customerId: 'cus_test_G', subId: 'sub_test_4', status: 'past_due' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).toHaveBeenCalledExactlyOnceWith(customer.id, {
      stripeSubscriptionId: 'sub_test_4',
      subscriptionStatus: 'Past Due',
    });
  });

  it('writes Subscription Status=Cancelled for status=canceled (Stripe American → Cancelled)', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_H' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'updated', customerId: 'cus_test_H', subId: 'sub_test_5', status: 'canceled' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).toHaveBeenCalledExactlyOnceWith(customer.id, {
      stripeSubscriptionId: 'sub_test_5',
      subscriptionStatus: 'Cancelled',
    });
  });

  it('is a no-op for an unmapped Stripe status', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_I' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'updated', customerId: 'cus_test_I', subId: 'sub_test_6', status: 'frobnicate' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.deleted', () => {
  it('writes Subscription Status=Cancelled', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_J' });
    mockGetCustomers.mockResolvedValue([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'deleted', customerId: 'cus_test_J', subId: 'sub_test_7', status: 'canceled' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerFields).toHaveBeenCalledExactlyOnceWith(customer.id, {
      stripeSubscriptionId: 'sub_test_7',
      subscriptionStatus: 'Cancelled',
    });
  });
});

describe('unhandled event types', () => {
  it('returns 200 with no writes for unhandled event types', async () => {
    const event = { ...setupIntentEvent({ customerId: 'cus_x' }), type: 'payment_intent.succeeded' as const };
    const req = makeSignedRequest(event);

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mockUpdateCustomerFields).not.toHaveBeenCalled();
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockGetCustomers).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  it('returns 500 "Handler error" when a write throws (so Stripe retries)', async () => {
    const customer = makeCustomer({ stripeCustomerId: 'cus_test_K' });
    mockGetCustomers.mockResolvedValue([customer]);
    mockUpdateCustomerFields.mockRejectedValueOnce(new Error('DB write failed'));

    const req = makeSignedRequest(
      subscriptionEvent({ type: 'created', customerId: 'cus_test_K', subId: 'sub_test_8', status: 'active' }),
    );
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Handler error' });
  });
});

describe('gaps in current behavior (test.todo)', () => {
  it.todo(
    'event-ID idempotency — same event.id delivered twice should be processed once; needs a processed_stripe_events table',
  );
  it.todo(
    'setup_intent.succeeded should also clear customers.atRisk + atRiskReason when reason was "No CC" (per plan §4, Phase 2 work)',
  );
});
