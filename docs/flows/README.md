# Onboarding flows — overview & key forks

LaunchPad runs three distinct onboarding workflows. They look similar at a glance (form → onboarding call → ongoing) but **fork in important ways** that determine task dependencies, automations, and customer experience.

**Read this before reading any individual flow doc.** Bugs creep in when one flow's pattern is assumed to apply to another.

## The three workflows

| Workflow Key | For | Total Tasks | Doc |
|---|---|---|---|
| `D2C-Standard` | Direct-to-consumer real estate agents | 17 + revision tasks | [d2c-standard.md](./d2c-standard.md) |
| `B2B-Keyes` | Keyes brokerage agents | 13 + reschedule tasks | [b2b-keyes.md](./b2b-keyes.md) |
| `B2B-BW` | Baird & Warner brokerage agents | 12 + reschedule tasks | [b2b-bw.md](./b2b-bw.md) |

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
| `B2B-Keyes` | B2B intake handler (LaunchPad) | Agent verifies email on `/keyes` landing page, found in roster |
| `B2B-BW` | B2B intake handler (LaunchPad) | Agent verifies email on `/bw` landing page, found in roster |

D2C customers come THROUGH HubSpot (sales flow). B2B customers come from the brokerage roster — they're pre-known, and LaunchPad creates the customer + pushes a Ticket to HubSpot in one shot.

---

## Where bugs creep in (rules of thumb)

1. **`workflow_templates` is the source of truth for stages and dependencies.** When unsure how a task gets activated, query: `SELECT stage, task_title, depends_on FROM workflow_templates WHERE workflow_key = '<key>' ORDER BY stage_order, task_order;`

2. **Mark Onboarding Call Complete has no dependencies in any template.** It's the hand-off marker between customer-side scheduling and CSM-side post-call work. Historically activated by Calendly webhook + Auto 4 logic; in the HubSpot era this needs a ticket-stage webhook handler (HubSpot Ticket → `Active` → mark this task Completed). Until that webhook is built, this task will sit as Draft after the call completes and the entire Post Onboarding / Review & Grow chain won't activate. **This is the same shape across all three workflows.**

3. **A change to one flow shouldn't silently apply to the others.** All three workflows are independent rows in `workflow_templates`. When updating, always verify which `workflow_key` you're touching — and consider whether the change should propagate to the others or is fork-specific.

4. **D2C portal default-stage UX:** Because Prepare-for-Onboarding runs parallel for D2C, a customer can have active tasks across two stages at once (Stage 2 "Schedule Call" AND Stage 3 "Watch Video / Sign In"). The portal's default-stage selection has to handle this — see `d2c-standard.md` for known caveats.
