# Onboarding flows — overview & key forks

LaunchPad runs three distinct onboarding workflows. They look similar at a glance (form → onboarding call → launched) but **fork in important ways** that determine task dependencies, automations, and customer experience.

**Read this before reading any individual flow doc.** Bugs creep in when one flow's pattern is assumed to apply to another.

> **2026-05-14 — post-launch architectural simplification (Phase 1).** LaunchPad's responsibility now ends at `Launched` (customer has credentials + signed in). Everything post-launch (CSM tasks, attention-state management, check-ins) lives in HubSpot. The 6 post-launch task templates were deleted from all three workflows; see `docs/plans/post-launch-migration.md` for the full migration plan.

## The three workflows

| Workflow Key | For | Total Tasks (post-Phase-1) | Doc |
|---|---|---|---|
| `D2C-Standard` | Direct-to-consumer real estate agents | 11 + revision tasks | [d2c-standard.md](./d2c-standard.md) |
| `B2B-Keyes` | Keyes brokerage agents | 8 + reschedule tasks | [b2b-keyes.md](./b2b-keyes.md) |
| `B2B-BW` | Baird & Warner brokerage agents | 7 + reschedule tasks | [b2b-bw.md](./b2b-bw.md) |

---

## Fork 1: Design phase (D2C only)

**D2C:** Rejig creates custom designs for the agent. The agent **must approve the designs before they can book their onboarding call**. Design approval is the gate.

```
D2C:  Form → Designer creates → Senior reviews → Proof uploaded
        → Agent APPROVES designs
            → Agent can now book onboarding call
```

**B2B (Keyes + BW):** Designs are **mandated by the brokerage**. There's no design step to approve. The agent goes straight from confirming their info to booking the call.

```
B2B-BW:     Form (pre-filled from roster) → Agent confirms → can book call
B2B-Keyes:  Form (pre-filled from roster) → Agent confirms → Stripe trial → can book call
```

This fork is why D2C has 5 design-related tasks (Create Designs, Review Designs, Upload Proof, Review & Approve Brand Kit, Move Designs to Production) that don't exist in B2B at all.

---

## Fork 2: Prepare-for-Onboarding timing

After the agent books their call, internal "Prepare for Onboarding" work happens (account creation, credentials, customer-side video + sign-in). The flows differ on **when** this kicks off.

**D2C:** Prepare-for-Onboarding **runs IN PARALLEL with the agent scheduling the call**. Both branches gate on design approval, so internal work can start the moment the customer approves designs. By design, the agent has credentials in hand BEFORE the onboarding call so they can sign in during it.

```
D2C, after design approval:
    ├─ (Client)  Schedule Onboarding Call
    └─ (Team)    Move Designs to Production → Create Account → Send Credentials → (Client) Watch Video + Sign In
       Both branches must complete before the onboarding call.
```

**B2B:** Prepare-for-Onboarding **runs SEQUENTIALLY after the agent schedules the call**. No internal work starts until the agent has booked. Credentials arrive AFTER the call is booked.

```
B2B:
    Schedule Onboarding Call
        → Create Account → Send Credentials → Watch Video + Sign In
```

The rationale for D2C parallel: D2C is custom-design heavy, so we frontload more self-onboarding to maximize call value. B2B has lower per-customer investment and the call IS the first deep touchpoint.

> ⚠️ This fork is the source of a real-world UX confusion for D2C — see `d2c-standard.md` "Parallel-track UX caveats."

---

## Fork 3: Payment

| Workflow | Payment timing | Mode |
|---|---|---|
| `D2C-Standard` | Already paid at HubSpot deal closedwon (Stripe Checkout happens before portal access) | pre-paid |
| `B2B-Keyes` | Stripe trial signup during Getting Started (30 days, credit card required) | setup-intent-at-intake |
| `B2B-BW` | No payment — brokerage has a master agreement; agents don't pay | none |

The `payment_mode` column on `workflow_templates` is the source of truth and feeds `handle-call-completed.ts` automation.

---

## Fork 4: Customer record creation

| Workflow | Created by | Trigger |
|---|---|---|
| `D2C-Standard` | LaunchPad closedwon webhook handler | HubSpot Deal moves to `closedwon` |
| `B2B-Keyes` | B2B intake handler (LaunchPad) | Today: admin Add Customer in `/admin`. Future: agent verifies email on `/keyes` landing page (DMG roster lookup) |
| `B2B-BW` | B2B intake handler (LaunchPad) | Today: admin Add Customer in `/admin`. Future: `/bw` landing page (DMG roster lookup) |

D2C customers come THROUGH HubSpot (sales flow — LP reads the closedwon Deal). B2B customers DON'T have a Deal — they go straight from form intake to LP customer creation. LaunchPad pushes the agent Contact + Pre-Onboarding Ticket to HubSpot at customer-creation time. Both are associated to the brokerage Company (Keyes Realty or Baird & Warner), NOT to the enterprise Deal.

**B2B Company association requirement:** the brokerages table must have `hubspot_company_id` populated for each brokerage. Without it, the LP→HS push errors out (LP customer still lands, but no HubSpot side-effect). Populate via `scripts/seed-brokerage-hubspot-company-ids.ts`.

---

## Where bugs creep in (rules of thumb)

1. **`workflow_templates` is the source of truth for stages and dependencies.** When unsure how a task gets activated, query: `SELECT stage, task_title, depends_on FROM workflow_templates WHERE workflow_key = '<key>' ORDER BY stage_order, task_order;`

2. **There is no longer a `Mark Onboarding Call Complete` task** (deleted 2026-05-14 in Phase 1). The post-launch lifecycle lives entirely in HubSpot — Workflow A moves the Ticket → `Active` when the Meeting outcome flips to `Completed`. The LaunchPad → HubSpot bi-directional sync (Phase 3 of the migration) mirrors that into `customers.onboardingState`. The only LP-side action triggered by Ticket → `Active` is Stripe trial-sub creation for B2B-Keyes-style workflows (belt A in the plan).

3. **A change to one flow shouldn't silently apply to the others.** All three workflows are independent rows in `workflow_templates`. When updating, always verify which `workflow_key` you're touching — and consider whether the change should propagate to the others or is fork-specific.

4. **D2C portal default-stage UX:** Because Prepare-for-Onboarding runs parallel for D2C, a customer can have active tasks across two stages at once (Stage 2 "Schedule Call" AND Stage 3 "Watch Video / Sign In"). The portal's default-stage selection has to handle this — see `d2c-standard.md` for known caveats.

5. **`Launched` is the terminal stage for Core workflows** (after Phase 1). Auto 2's "no next stage" branch writes `currentStage = 'Launched'` for `product='Core'`; Voice/Avatar add-on workflows retain `'Done'` as their terminal. When a Core customer reaches `Launched`, LaunchPad also pushes the HubSpot Ticket from `Pre-Onboarding` → `Onboarding Scheduled` (best-effort) — that's the hand-off point where HS Workflows F / A / B / etc. take over the lifecycle.

6. **The customer portal switches surfaces at Launched.** `/r/[token]` renders `<PortalHandyPage>` when `customer.currentStage === 'Launched'`, with links to the product, support session booking, and an account summary. The `TaskList` view is hidden — the customer's onboarding journey is complete.
