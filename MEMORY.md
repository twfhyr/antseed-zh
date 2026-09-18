# Agent Memory — antseed-zh

Read `AGENTS.md` first — it is the workflow contract for this repo
(no-fabricated-numbers rule, i18n, build/deploy, commit policy). This file
adds owner-mandated rules that agents must load before developing.

## Plan-First Development (owner-mandated 2026-09-17)

**For every new feature, write an implementation plan and get the owner's
review BEFORE writing any code.** Model-independent rule: whichever model is
running the session must follow it. Workflow:

1. Write a short plan: what the feature does, which files/routes/components
   change, data sources for any new numbers (hard no-fabrication rule —
   every figure must trace to network.antseed.com/stats, Antscan GraphQL,
   or a live Base mainnet read), i18n impact (zh default + en), and how it
   will be verified. Present it in the conversation; for larger features
   also save it to `notes/plans/<feature>.md`.
2. **Stop after presenting the plan.** Do not implement in the same turn.
3. Implement only after the owner explicitly approves ("go ahead",
   "approved", "implement it", …). If implementation reveals the plan was
   wrong, say so and re-confirm before diverging significantly.

Scope: new features and non-trivial behavior changes. Not required for bug
fixes, typo/copy fixes, or when the owner's request is already detailed
enough to BE the plan — when unsure, ask.

The same rule also lives in `/root/tian/antseed/MEMORY.md` (the monorepo's
agent memory, auto-loaded by opencode sessions started there); keep the two
copies in sync if either changes.

## Endpoint/model changes don't change the rules

The owner runs opencode against multiple AntSeed buyer proxies (e.g. the
8378 buyer and the "sg" buyer on 8379, more may appear) and switches models
freely. This file is loaded from the project directory by every session, so
the rules above apply regardless of which endpoint, seller, or model is
active. Full endpoint details: `/root/tian/antseed/MEMORY.md` §"opencode
Model Routing on This Server".
