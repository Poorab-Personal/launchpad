# Onboarding flows — overview & key forks

LaunchPad runs six Core onboarding workflows (plus two add-on workflows). They look similar at a glance (form → onboarding call → launched) but **fork in important ways** that determine task dependencies, automations, and customer experience.

**Read this before reading any individual flow doc.** Bugs creep in when one flow's pattern is assumed to apply to another.

> **2026-05-14 — post-launch architectural simplification (Phase 1).** LaunchPad's responsibility now ends at `Launched` (customer has credentials + signed in). Everything post-launch (CSM tasks, attention-state management, check-ins) lives in HubSpot. The 6 post-launch task templates were deleted from all three workflows; see `docs/plans/post-launch-migration.md` for the full migration plan.

## The workflows

Template counts below are live `workflow_templates` rows, verified 2026-10-19.

| Workflow Key | For | Template tasks | Billing | Doc |
|---|---|---|---|---|
| `D2C-Standard` | Direct-to-consumer real estate agents | 11 | pre-paid | [d2c-standard.md](./d2c-standard.md) |
| `B2B-Keyes` | Keyes agents | 8 | agent, Stripe trial | [b2b-keyes.md](./b2b-keyes.md) |
| `B2B-IPRE` | Illustrated Properties agents | 8 | agent, Stripe trial | Keyes clone — see [b2b-keyes.md](./b2b-keyes.md) |
| `B2B-BW` | Baird & Warner agents | 7 | brokerage, invoice | [b2b-bw.md](./b2b-bw.md) |
| `B2B-Coach` | Coach Realtors agents | 7 | brokerage, invoice | BW clone — see [b2b-bw.md](./b2b-bw.md) |
| `B2B-RUHL` | RuhlHomes agents | 7 | brokerage, invoice | [b2b-ruhl.md](./b2b-ruhl.md) — **forks per agent** |

Plus `Addon-Voice` (4 tasks) and `Addon-Avatar` (5), which run as parallel
workflows keyed off the `product` enum rather than replacing the Core flow.

**IPRE and Coach are deliberate clones** of Keyes and BW respectively. They have
no doc of their own because they have no fork of their own — if you find yourself
documenting a difference, that difference is probably a bug. Ruhl started as a BW
clone and has since forked (see Fork 5).

---

## Fork 1: Design phase (D2C only)

**D2C:** Rejig creates custom designs for the agent. The agent **must approve the designs before they can book their onboarding call**. Design approval is the gate.

```
D2C:  Form → Designer creates → Senior reviews → Proof uploaded
        → Agent APPROVES designs
            → Agent can now book onboarding call
```

**B2B (all five):** Designs are **mandated by the brokerage**. There's no design step to approve. The agent goes straight from confirming their info to booking the call.

```
B2B-BW / Coach / RUHL:  Form (pre-filled from roster) → Agent confirms → can book call
B2B-Keyes / IPRE:       Form (pre-filled from roster) → Agent confirms → Stripe trial → can book call
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

| Workflow | Payment timing | `payment_mode` |
|---|---|---|
| `D2C-Standard` | Already paid at HubSpot deal closedwon (Stripe Checkout happens before portal access) | `pre-paid` |
| `B2B-Keyes`, `B2B-IPRE` | Stripe trial signup during Getting Started (30 days, credit card required) | `setup-intent-at-intake` |
| `B2B-BW`, `B2B-Coach`, `B2B-RUHL` | No agent payment — the brokerage has a master agreement and is invoiced | `invoice` |

The `payment_mode` column on `workflow_templates` is the source of truth and feeds `handle-call-completed.ts` automation.

> An `invoice`-mode agent with no Stripe subscription is **not a billing gap** — don't chase it. See the brokerage-billing-models note.

---

## Fork 4: Customer record creation

| Workflow | Created by | Trigger |
|---|---|---|
| `D2C-Standard` | LaunchPad closedwon webhook handler | HubSpot Deal moves to `closedwon` |
| All `B2B-*` | B2B intake handler (LaunchPad) | Agent identifies themselves on the brokerage landing page (`/keyes`, `/b&w`, `/ipre`, `/ruhl`, `/coach`) and is matched against `brokerage_roster`. `/admin` Add Customer remains as a manual fallback. |

**The row is created on landing, not on submit.** The agent gets a customer row
and a full task set the moment they hit the landing page — before the intake form
is answered. Any logic that needs a form answer therefore cannot live in
`generate-tasks.ts`; it has to run on intake completion and amend what already
exists. Fork 5 is the worked example.

It also means **"customer row exists" is not a submission.** A submission is
`Confirm Your Information` reaching `Completed` — the same event that fires the
Slack intake alert. `scripts/ruhl-submission-status.ts` separates the two.

D2C customers come THROUGH HubSpot (sales flow — LP reads the closedwon Deal). B2B customers DON'T have a Deal — they go straight from form intake to LP customer creation. LaunchPad pushes the agent Contact + Pre-Onboarding Ticket to HubSpot at customer-creation time. Both are associated to the brokerage Company (Keyes Realty or Baird & Warner), NOT to the enterprise Deal.

**B2B Company association requirement:** the brokerages table must have `hubspot_company_id` populated for each brokerage. Without it, the LP→HS push errors out (LP customer still lands, but no HubSpot side-effect). Populate via `scripts/seed-brokerage-hubspot-company-ids.ts`.

---

## Fork 5: Service option — the fork inside a workflow (Ruhl only)

Every other fork above is **per workflow**. Ruhl forks **per agent**.

At intake, a Ruhl agent answers "Who will be managing Rejig?":

| Answer | `customers.service_option` | What happens |
|---|---|---|
| "I'll manage it myself" | `Self-Managed` | Standard flow — books their own onboarding call, watches the video, signs in. |
| "Ruhl Marketing Team" | `Brokerage-Managed` | Booking, video and sign-in tasks are auto-completed. The agent is never shown an onboarding step; the brokerage's marketing team runs the account. |

Mechanically the agent always gets the full task set (see Fork 4) and the unwanted
tasks are **closed** afterwards:

```
Confirm Your Information completes
    ├─ Self-Managed       → Schedule Your Onboarding Call activates (normal)
    └─ Brokerage-Managed  → Schedule Your Onboarding Call auto-Completed
                            (via handleTaskCompleted — see the caveat below)

Send Credentials completes
    └─ Brokerage-Managed  → Watch Setup Video + Sign In auto-Completed
                            → stage advances to Launched
```

Credentials for a `Brokerage-Managed` agent are sent to **both** the agent and
`brokerages.managed_cc_email` (`marketing@ruhlhomes.com`).

> ⚠️ **The booking close must route through `handleTaskCompleted`.** Stage advance
> only re-evaluates the stage of the task that triggered it, and the booking task
> is in a different stage from intake. A raw `db.update` closes the row but leaves
> the customer pinned at `Getting Started` permanently. The terminal tasks are
> different — they share a stage with Send Credentials, so a plain UPDATE is fine
> there and avoids a recursive run.

> ⚠️ **`Brokerage-Managed` agents reach `Launched` without an onboarding call ever
> happening.** Any report that infers "onboarded" from a held call or a Stripe sub
> will miscount them. `ONBOARDED_RULE` in `monthly-cohort-digest.ts` keys Ruhl off
> sign-in for this reason — which is now partly an auto-completed signal rather
> than a real one. Worth revisiting if Ruhl onboarding numbers start looking too good.

This fork is the one to copy if another brokerage wants a done-for-you tier. The
form question is gated on `workflowKey === 'B2B-RUHL'` in `FormTask.tsx`, so
extending it to a second brokerage is a one-line change plus a `managed_cc_email`.

---

## Where bugs creep in (rules of thumb)

1. **`workflow_templates` is the source of truth for stages and dependencies.** When unsure how a task gets activated, query: `SELECT stage, task_title, depends_on FROM workflow_templates WHERE workflow_key = '<key>' ORDER BY stage_order, task_order;`

2. **There is no longer a `Mark Onboarding Call Complete` task** (deleted 2026-05-14 in Phase 1). The post-launch lifecycle lives entirely in HubSpot — Workflow A moves the Ticket → `Active` when the Meeting outcome flips to `Completed`. The LaunchPad → HubSpot bi-directional sync (Phase 3 of the migration) mirrors that into `customers.onboardingState`. The only LP-side action triggered by Ticket → `Active` is Stripe trial-sub creation for B2B-Keyes-style workflows (belt A in the plan).

3. **A change to one flow shouldn't silently apply to the others.** All six workflows are independent rows in `workflow_templates`. When updating, always verify which `workflow_key` you're touching — and consider whether the change should propagate to the others or is fork-specific. Seven workflow rows now carry a `Schedule Your Onboarding Call` task; a "just fix the booking step" change usually means seven rows, not one.

4. **D2C portal default-stage UX:** Because Prepare-for-Onboarding runs parallel for D2C, a customer can have active tasks across two stages at once (Stage 2 "Schedule Call" AND Stage 3 "Watch Video / Sign In"). The portal's default-stage selection has to handle this — see `d2c-standard.md` for known caveats.

5. **`Launched` is the terminal stage for Core workflows** (after Phase 1). Auto 2's "no next stage" branch writes `currentStage = 'Launched'` for `product='Core'`; Voice/Avatar add-on workflows retain `'Done'` as their terminal. When a Core customer reaches `Launched`, LaunchPad also pushes the HubSpot Ticket from `Pre-Onboarding` → `Onboarding Scheduled` (best-effort) — that's the hand-off point where HS Workflows F / A / B / etc. take over the lifecycle.

6. **The customer portal switches surfaces at Launched.** `/r/[token]` renders `<PortalHandyPage>` when `customer.currentStage === 'Launched'`, with links to the product, support session booking, and an account summary. The `TaskList` view is hidden — the customer's onboarding journey is complete.

7. **A task's `embed_url` is a snapshot, not a pointer.** `generate-tasks.ts` copies the booking link off `brokerages.default_calendly_url` (falling back to the template's `embed_url`) when the task row is created. Re-pointing a link means updating `brokerages`, `workflow_templates`, **and** every open `tasks` row — `scripts/offboard-mario-luis.ts` is the worked example. A dead HubSpot Meetings link still returns 200, so a missed row fails silently.

8. **Changing the task set means auditing every consumer.** A new or auto-completed task name touches the portal, stage advance, the Slack intake trigger, `STUCK_WORKFLOW_KEYS`, `TERMINAL_CLIENT_TASKS`, and the reporting rules in `scripts/funnel-audit-labels.ts` + `monthly-cohort-digest.ts`. The Ruhl fork had to touch five of those.
