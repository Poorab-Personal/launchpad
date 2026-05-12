# Review — Stripe Plans table proposal

**Status:** Historical — architect review of the original Stripe Plans table proposal. Stripe Plans table shipped (now `stripe_plans` in Postgres); review notes reflected in the final shape. Retained for traceability.

**Reviewer perspective:** architect with skin in the "don't over-engineer" game; you've burned time on this before.

**Headline verdict:** the proposal is mostly right but is heavier than today's reality requires. You have a 2-row problem (Keyes Monthly, Keyes Quarterly Prepay) and you're proposing a 9-column dimension table with link fields, defaults, ordering, and active flags. Some of that earns rent. Some is speculative and can wait. The sin you're closest to repeating is *imagining* the add-on shape before any add-on actually ships through LaunchPad — and pre-baking it into Plans on day one.

---

## Per-question verdict

### Q1 — Single table vs split (Core / Add-on) → ⚠ change

**Proposed:** one `Stripe Plans` table with `Plan Type` discriminator (`Core | Voice Add-on | Avatar Add-on`).

**Pushback:** today's actual problem is "Keyes has two core plans." Voice/Avatar add-ons aren't in the LaunchPad billing path *at all* yet — the v2 plan's "What this plan does NOT cover" explicitly defers add-on payment flows to a separate Phase 5. You're solving for Phase 5 in the schema you ship for Phase 0.

The discriminator is also probably wrong on the merits. A "Core" plan answers "what is the agent paying for the subscription?" An add-on answers "what extra line item gets added to an existing sub?" Those have different lifecycles (add-ons can be added/removed mid-sub; core plans are the sub itself), different cardinalities (1 core per customer; N add-ons per customer), and different selection moments (core at intake; add-ons potentially anytime). When Phase 5 lands, the add-on pricing model will likely want fields the core model doesn't (proration policy, "added at" timestamp, "active on customer" link).

**Recommendation:** ship `Stripe Plans` as **core-only** for now (drop `Plan Type` from v1 of the table). When add-ons ship for real in Phase 5, decide *then* whether to widen the table or add `Stripe Add-Ons` as a second table — informed by what add-on selection actually looks like.

---

### Q2 — `Workflow Key` as text vs linked record → ✓ ship as proposed (text)

The whole project treats Workflow Key as a denormalized string by design — it's a formula on Customer, a text column on Workflow Templates, the seed script's primary index. CLAUDE.md is explicit about *why* (avoid linked-record race conditions in automations). Inventing a `Workflow Keys` link table just for the Plans join would be a one-off that breaks the convention.

Add a single-line text validation note in the table description ("must match a Workflow Templates.Workflow Key") and move on.

---

### Q3 — Trial Days location → ⚠ change (one writer per concept)

You're proposing per-plan Trial Days because *plausibly* monthly might have a 14-day trial and prepay might not.

**(a)** If plans within a workflow can legitimately have different trials → keep Trial Days on the Plan, drop it from Workflow Templates.

**(b)** If trial is a property of the workflow, not the plan → leave Trial Days on Workflow Templates, don't put it on Plans at all.

The proposal as written has Trial Days on Plans **and** still implicitly on Workflow Templates. That's two writers, drift guaranteed. **One writer per concept.**

My lean: (a). Quarterly prepay with a 14-day trial doesn't make sense (they're committing money), so the plans-can-differ case is real. **Ask Poorab, don't decide on his behalf.**

---

### Q4 — `Default` checkbox → ✗ scrap (for now)

This is the clearest over-engineering signal in the proposal. You have 2 plans. The portal needs to render 2 options. An agent picks one. Done.

A "default" pre-selected option is:
- A nudge mechanism (UX/conversion lever)
- That requires a CSM to think about which plan to push
- For a product where you don't yet have any data on which plan converts better
- And where the harm of *not* having it is one extra click

Skip it. If Poorab later says "we want to nudge agents toward the quarterly prepay because unit economics," add the field then.

Same skepticism for `Display Order` — do you have 4+ plans for any workflow? If there are 2, ordering is "the array as fetched, sorted by Plan Name." Add `Display Order` when there's a 3rd plan and CSM disagrees with alpha order.

`Active` checkbox — keep. Retiring a plan happens; deleting an Airtable row that has historical Customer links is destructive. Cheap insurance.

`Description` — keep, this one earns rent immediately ("Save 16% by prepaying" is real conversion copy).

---

### Q5 — `Customer.Selected Plan`: link vs text → ⚠ change to text (denormalized Stripe Price ID)

What is "Selected Plan" for, semantically? It's the Stripe price the customer agreed to pay. It's *Stripe's* price ID that matters; Plans is just the human-readable wrapper.

- Store `Customer.Selected Stripe Price ID` (text). That's the load-bearing data.
- If you also want a human-readable view in CSM workspace, add `Selected Plan Name` as a denormalized text snapshot at intake (or compute in the workspace UI by querying Plans on render).

This is *also* consistent with how the whole base treats this kind of thing — `HubSpot Deal ID`, `Stripe Customer ID`, `Stripe Subscription ID` are all denormalized text. You don't link Customer → some "Stripe Customers" table. The convention here is: external-system IDs are text.

Sub creation reads `Customer.Selected Stripe Price ID` directly. No join. Simpler.

---

### Q6 — Universal vs per-brokerage add-on pricing → dissolved by Q1

If you take Q1's recommendation (drop add-ons from v1 of Plans), Q6 doesn't exist yet. Decide it when add-ons actually ship. The proposed "Workflow Key blank = universal" toggle is clever but it's solving an imagined problem — you don't know yet whether Voice will be priced per-brokerage or universally.

Sentinels age badly.

---

### Q7 — Migration: leave deprecated or delete? → ⚠ delete via UI

The same project that just deleted `Reminder Count`, `Reminder After Days`, `Max Reminders` as dead weight should not turn around and leave `Stripe Price ID` and `Trial Days` on Workflow Templates as dead weight. That's the over-engineering pattern in microcosm — "I'll just leave it, what's the harm." The harm is the next architect review six weeks from now writing a paragraph about dead fields again.

**Recommendation:** delete via UI as part of the Plans table introduction. It's 30 seconds of clicking. Worth it for hygiene. Update the seed script + mappers in the same commit.

---

### Q8 — What you missed / where you're over-engineering

1. **Plan selection timing.** Where in the funnel does an agent pick? At intake (before card capture)? On the SetupIntent page? After the call? Decide before building the table.

2. **What happens for `pre-paid` D2C?** D2C-Standard's price is set upstream by HubSpot/Stripe. Lean: Plans is a setup-intent-at-intake-only concept for v1. Document that in one sentence. Don't build D2C Plans rows speculatively.

3. **`B2B-BW` invoice mode.** No plans needed. Confirm the seed script skips it.

4. **Required-when-Mode logic.** New constraint: "≥1 Plan row exists with this Workflow Key when Workflow's `Payment Mode = setup-intent-at-intake`." Airtable can't enforce this — has to live in the seed script + a workspace audit query. Worth a sentence in the plan.

5. **Anti-pattern check.** Apply this filter to every column:
   - `Display Order`: who reads it? portal. when? after 3+ plans exist. → defer.
   - `Default`: who reads it? portal. when? when CSM has data on conversion. → defer.
   - `Plan Type`: who reads it? Phase 5 add-on logic. when? Phase 5. → defer.
   - `Active`: who reads it? portal filter + seed script. when? first time a plan is retired. → keep.
   - `Description`: who reads it? portal. when? immediately, day-one Keyes UX. → keep.

   Apply this filter and Plans goes from 9 columns to 6.

6. **One thing the proposal is *right* about.** Replacing the workflow-level Stripe Price ID with a separate table *is* the correct move the moment you have N>1 plans per workflow. Don't let "don't over-engineer" talk you into encoding two prices in a comma-separated text field or a JSON blob. The Plans table is the simplest shape that handles N — it's just bigger than it needs to be in the proposed form.

---

## Top 3 changes I'd make

1. **Strip the table to 6 columns for v1.** Drop `Plan Type`, `Display Order`, and `Default`. Keep Plan Name, Workflow Key (text), Stripe Price ID, Trial Days, Active, Description. Add the dropped columns *only* when add-ons ship (Phase 5) or when CSM provides actual data demanding them.

2. **`Customer.Selected Stripe Price ID` as text, not a link to Plans.** Matches the rest of the base's external-ID convention. Sub-creation automation reads price ID directly; no link dereference. Add a denormalized `Selected Plan Name` text snapshot at intake if CSM workspace needs the human-readable label without a join.

3. **Delete `Workflow Templates.Stripe Price ID` and `Trial Days` via UI when introducing Plans.** Same hygiene rule the project just applied to `Reminder Count` et al. Don't leave them as `(deprecated)`.

**Bonus zero-th change:** before any of this, confirm whether different plans within a workflow can legitimately have different trial-day values (Q3). If no, Trial Days stays on Workflow Templates. If yes, Trial Days lives on Plan exclusively. **Pick one writer.**
