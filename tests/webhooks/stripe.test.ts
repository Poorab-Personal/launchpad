/**
 * Phase 1.5 — Stripe webhook integration tests.
 *
 * Regression net before the Phase 3 Airtable→Postgres port. These tests
 * target the EXISTING Airtable-backed route at src/app/api/webhooks/stripe/
 * and assert observable behavior (HTTP responses, Airtable mutations).
 *
 * The same suite re-runs in Phase 3 against Postgres-backed routes;
 * assertions on the wire-layer mock translate to assertions on Drizzle
 * write calls at that point.
 *
 * Mocking strategy:
 *   - Mock @/lib/airtable-client (the wire layer — 5 functions)
 *   - Real airtable.ts mappers run end-to-end
 *   - Real stripe.webhooks.constructEvent (signature verifier) runs
 *   - Signed payloads built via stripe.webhooks.generateTestHeaderString
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

// vi.mock is hoisted above any imports — must declare before importing route.
vi.mock('@/lib/airtable-client', () => ({
  getRecord: vi.fn(),
  getRecords: vi.fn(),
  updateRecord: vi.fn(),
  createRecord: vi.fn(),
  batchCreateRecords: vi.fn(),
}));

import * as airtableClient from '@/lib/airtable-client';
import { POST } from '@/app/api/webhooks/stripe/route';
import type { NextRequest } from 'next/server';

const WEBHOOK_SECRET = 'whsec_test_secret_phase15_vitest';
const stripe = new Stripe('sk_test_dummy_phase15_vitest');

// ---- Fixtures ------------------------------------------------------------

type AirtableRec = { id: string; fields: Record<string, unknown>; createdTime: string };

function customerRec(opts: {
  id?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  taskIds?: string[];
}): AirtableRec {
  return {
    id: opts.id ?? 'recCust1',
    fields: {
      Name: 'Test Agent',
      'Contact Email': 'test@example.com',
      'Platform Email': 'test@example.com',
      'Stripe Customer ID': opts.stripeCustomerId ?? '',
      'Stripe Subscription ID': opts.stripeSubscriptionId ?? '',
      Tasks: opts.taskIds ?? [],
      'Current Stage': 'Getting Started',
      Type: 'D2C',
      Channel: 'Standard',
      'Workflow Key': 'D2C-Standard',
    },
    createdTime: '2026-01-01T00:00:00Z',
  };
}

function taskRec(opts: {
  id?: string;
  taskName: string;
  status: string;
  customerId?: string;
}): AirtableRec {
  return {
    id: opts.id ?? 'recTask1',
    fields: {
      'Task Name': opts.taskName,
      Status: opts.status,
      'Task Type': 'Client',
      Stage: 'Getting Started',
      'Stage Order': 1,
      'Task Order': 1,
      Customer: [opts.customerId ?? 'recCust1'],
      'Visible To Client': true,
      'Has Team Review': false,
      'Attachment Type': 'None',
      Product: 'Core',
    },
    createdTime: '2026-01-01T00:00:00Z',
  };
}

// Build a minimal but plausible Stripe.Event JSON. The signature verifier
// doesn't validate the inner shape; the route reads .type, .id, and the
// nested .data.object.{customer, id, status}.
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
      object: {
        id: 'seti_test_1',
        object: 'setup_intent',
        customer: opts.customerId,
        status: 'succeeded',
      },
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
      object: {
        id: opts.subId,
        object: 'subscription',
        customer: opts.customerId,
        status: opts.status,
      },
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
  // Route uses `request.headers.get()` and `request.text()` — plain Request is enough.
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  }) as unknown as NextRequest;
}

// ---- Mock helpers --------------------------------------------------------

const mockGetRecords = vi.mocked(airtableClient.getRecords);
const mockUpdateRecord = vi.mocked(airtableClient.updateRecord);

function mockCustomersList(customers: AirtableRec[]) {
  // First call to getRecords with 'Customers' returns the list; subsequent
  // calls with 'Tasks' should be handled separately.
  mockGetRecords.mockImplementation(async (table: string) => {
    if (table === 'Customers') return customers;
    if (table === 'Tasks') return [];
    return [];
  });
}

function mockCustomersAndTasks(customers: AirtableRec[], tasks: AirtableRec[]) {
  mockGetRecords.mockImplementation(async (table: string) => {
    if (table === 'Customers') return customers;
    if (table === 'Tasks') return tasks;
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: return a generic record from updateRecord so the mapper-after-
  // update path in updateCustomerFields doesn't choke.
  mockUpdateRecord.mockResolvedValue(customerRec({}));
});

// ---- Tests ---------------------------------------------------------------

describe('signature verification', () => {
  it('returns 200 for a validly-signed event (no matching customer = no-op)', async () => {
    mockCustomersList([]);
    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_no_match' }));

    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ received: true });
  });

  it('returns 400 "Invalid signature" for a malformed signature', async () => {
    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_x' }), {
      badSignature: true,
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid signature');
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });

  it('returns 400 "Missing signature" when the header is absent', async () => {
    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_x' }), {
      skipSignature: true,
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Missing signature');
    expect(mockUpdateRecord).not.toHaveBeenCalled();
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
    const customer = customerRec({
      id: 'recCustA',
      stripeCustomerId: 'cus_test_A',
      taskIds: ['recTaskA'],
    });
    const task = taskRec({
      id: 'recTaskA',
      taskName: 'Capture Payment Method',
      status: 'Active',
      customerId: 'recCustA',
    });
    mockCustomersAndTasks([customer], [task]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_test_A' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Tasks', 'recTaskA', {
      Status: 'Completed',
    });
  });

  it('is a no-op when Capture Payment Method task is already Completed', async () => {
    const customer = customerRec({
      stripeCustomerId: 'cus_test_B',
      taskIds: ['recTaskB'],
    });
    const task = taskRec({
      id: 'recTaskB',
      taskName: 'Capture Payment Method',
      status: 'Completed',
    });
    mockCustomersAndTasks([customer], [task]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_test_B' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });

  it('is a no-op when no Airtable customer matches the Stripe customer id', async () => {
    mockCustomersAndTasks([], []);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_nobody' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });

  it('is a no-op when setupIntent has no customer', async () => {
    mockCustomersAndTasks([], []);

    const req = makeSignedRequest(setupIntentEvent({ customerId: null }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });

  it('is a no-op when customer has no Capture Payment Method task', async () => {
    const customer = customerRec({
      stripeCustomerId: 'cus_test_C',
      taskIds: ['recOther'],
    });
    const otherTask = taskRec({
      id: 'recOther',
      taskName: 'Schedule Your Onboarding Call',
      status: 'Active',
    });
    mockCustomersAndTasks([customer], [otherTask]);

    const req = makeSignedRequest(setupIntentEvent({ customerId: 'cus_test_C' }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.created', () => {
  it('writes Stripe Subscription ID + Subscription Status=Trial for status=trialing', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_D' });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'created',
        customerId: 'cus_test_D',
        subId: 'sub_test_1',
        status: 'trialing',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Customers', customer.id, {
      'Stripe Subscription ID': 'sub_test_1',
      'Subscription Status': 'Trial',
    });
  });

  it('writes Subscription Status=Active for status=active', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_E' });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'created',
        customerId: 'cus_test_E',
        subId: 'sub_test_2',
        status: 'active',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Customers', customer.id, {
      'Stripe Subscription ID': 'sub_test_2',
      'Subscription Status': 'Active',
    });
  });

  it('is a no-op when no matching customer is found', async () => {
    mockCustomersList([]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'created',
        customerId: 'cus_nobody',
        subId: 'sub_x',
        status: 'active',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.updated', () => {
  it('updates Subscription Status on trial→active transition', async () => {
    const customer = customerRec({
      stripeCustomerId: 'cus_test_F',
      stripeSubscriptionId: 'sub_test_3',
    });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'updated',
        customerId: 'cus_test_F',
        subId: 'sub_test_3',
        status: 'active',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Customers', customer.id, {
      'Stripe Subscription ID': 'sub_test_3',
      'Subscription Status': 'Active',
    });
  });

  it('writes Subscription Status=Past Due for status=past_due', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_G' });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'updated',
        customerId: 'cus_test_G',
        subId: 'sub_test_4',
        status: 'past_due',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Customers', customer.id, {
      'Stripe Subscription ID': 'sub_test_4',
      'Subscription Status': 'Past Due',
    });
  });

  it('writes Subscription Status=Cancelled for status=canceled (Stripe American spelling → Cancelled)', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_H' });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'updated',
        customerId: 'cus_test_H',
        subId: 'sub_test_5',
        status: 'canceled',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Customers', customer.id, {
      'Stripe Subscription ID': 'sub_test_5',
      'Subscription Status': 'Cancelled',
    });
  });

  it('is a no-op for an unmapped Stripe status', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_I' });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'updated',
        customerId: 'cus_test_I',
        subId: 'sub_test_6',
        status: 'frobnicate',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).not.toHaveBeenCalled();
  });
});

describe('customer.subscription.deleted', () => {
  it('writes Subscription Status=Cancelled', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_J' });
    mockCustomersList([customer]);

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'deleted',
        customerId: 'cus_test_J',
        subId: 'sub_test_7',
        status: 'canceled',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockUpdateRecord).toHaveBeenCalledExactlyOnceWith('Customers', customer.id, {
      'Stripe Subscription ID': 'sub_test_7',
      'Subscription Status': 'Cancelled',
    });
  });
});

describe('unhandled event types', () => {
  it('returns 200 with no writes for unhandled event types', async () => {
    mockCustomersList([]);
    const event = {
      ...setupIntentEvent({ customerId: 'cus_x' }),
      type: 'payment_intent.succeeded' as const,
    };

    const req = makeSignedRequest(event);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mockUpdateRecord).not.toHaveBeenCalled();
    expect(mockGetRecords).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  it('returns 500 "Handler error" when an Airtable write throws (so Stripe retries)', async () => {
    const customer = customerRec({ stripeCustomerId: 'cus_test_K' });
    mockCustomersList([customer]);
    mockUpdateRecord.mockRejectedValueOnce(new Error('Airtable 500'));

    const req = makeSignedRequest(
      subscriptionEvent({
        type: 'created',
        customerId: 'cus_test_K',
        subId: 'sub_test_8',
        status: 'active',
      }),
    );
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Handler error' });
  });
});

describe('gaps in current behavior (Phase 2/3 work — tests pinned as todo)', () => {
  it.todo(
    'event-ID idempotency — same event.id delivered twice should be processed once; needs a processed_stripe_events table',
  );
  it.todo(
    'setup_intent.succeeded should also clear customers.atRisk + atRiskReason when the customer is At Risk=No CC (per plan §4, deferred to Phase 2)',
  );
});
