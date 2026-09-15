# notes/

This directory is the **live, forward-looking backlog** for antseed-zh —
as opposed to `docs/`, which is architecture reference plus historical
product specs (`docs/DEMAND.md`, `docs/REWRITE_PLAN.md`,
`docs/PAYMENTS_DEMAND.md`) that describe decisions already made and, for
the most part, already implemented.

- **`dev-plan.md`** — what's actually open right now: known gaps, deferred
  features, things a human should verify that couldn't be verified
  headlessly, and open questions with no obvious right answer yet. Update
  this file whenever you finish something on it or find something new that
  belongs on it — it should stay accurate, not grow stale like a plan
  document does.
- **Feature plans** (e.g. `epoch-features-plan.md`) — a written, reviewable
  plan for a specific non-trivial feature, following the same pattern:
  goal, confirmed real data sources, per-surface design, and explicit open
  questions the user needs to answer before implementation starts. Once a
  plan is approved and implemented, fold anything still-open into
  `dev-plan.md` and mark the plan file's status line "Implemented."

If you're an agent picking up work here, read `../AGENTS.md` first — it has
the non-negotiable rules (never fabricate a number, chief among them) that
everything in this file assumes.
