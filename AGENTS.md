# Agent Workflow — antseed-zh

This file is the workflow contract for anyone (human or agent) developing
in this repo. Read it before making changes; it's short on purpose.

## The one rule that overrides everything else

**Never fabricate a number.** If a real value can't be read from
`network.antseed.com/stats`, Antscan's GraphQL API, or a live Base mainnet
read, the UI renders `—`, not a guess. No hardcoded percentages, no
`someCount * assumedPrice` heuristics, no `uptime: 99.5`-style placeholder
constants, no seed/mock data in any path that ships. This project already
had that problem once (see `docs/REWRITE_PLAN.md` §1 and the comments in
`backend/sync-official.js`/`backend/database.js` for the specific
fabrications that were found and removed) — don't reintroduce it.

If you're not sure whether a number is real or invented, trace it to its
source before shipping it. `README.md`'s
["Data Sources & How Every Number Is Calculated"](README.md#data-sources--how-every-number-is-calculated)
table is the map of what backs every figure currently on screen — extend
it when you add a new one.

## Before you start

1. Read `README.md` (architecture + data sources) and
   `notes/dev-plan.md` (the live backlog) — don't re-discover context
   that's already written down, and don't duplicate work already listed
   there as open.
2. `docs/` has deeper reference (`ARCHITECTURE.md`) and historical planning
   docs (`DEMAND.md`, `REWRITE_PLAN.md`, `PAYMENTS_DEMAND.md`) — treat the
   planning docs as *why things are the way they are*, not as a live task
   list. `notes/dev-plan.md` is the live task list.
3. `git status` / `git log` before assuming the working tree matches the
   last commit — this repo has repeatedly carried large, real, uncommitted
   work in progress across sessions. Don't discard uncommitted changes
   without understanding what they are first.

## While developing

- **Contract addresses are never hardcoded.** Read them live via
  `@antseed/node`'s `resolveChainConfig()` (backend) or from
  `/api/deposits/config` / `/api/chain-stats` (frontend). `AntseedChannels`
  in particular is the one swappable contract in the protocol and *will*
  be redeployed again — a hardcoded address for it is a bug waiting to
  happen, not a simplification (this already happened once; see
  `notes/dev-plan.md`'s "Recently fixed" section).
- **New user-facing strings need both `src/i18n/en.js` and `src/i18n/zh.js`
  entries.** `zh` is the default locale — don't ship English-only copy.
- **If you add a tab to `App.jsx`, also register it in
  `src/hooks/useTabRouter.js`'s `TAB_PATHS`.** A tab not in `VALID_TABS`
  silently falls back to `overview` on direct navigation or reload — this
  is exactly the kind of thing that makes a feature look broken when it's
  actually just unwired.
- **Don't leave built-but-unreachable code without a reason written down.**
  If you're disabling a feature rather than deleting it, say so in a
  comment at the point it gets unmounted (see the pattern this repo already
  used, and the "Recently fixed" note in `notes/dev-plan.md` about what
  happened when that reasoning wasn't revisited). If you're removing code,
  confirm with `grep` that it's actually unreferenced first, not just
  unreferenced from the one file you're looking at.
- Simple beats complete: this dashboard deliberately curates a small set of
  headline numbers and one well-designed table per section rather than
  dumping every field the network payload has (see `docs/REWRITE_PLAN.md`
  §"Curation over completeness"). Don't add a raw-data dump because the
  field happens to be available.

## Before calling a change done

- `npm run build` must succeed. Treat it as a real signal, not a formality
  — it's caught genuine breakage before.
- For backend-only changes, at minimum `node --check backend/*.js`; if you
  can run the server, do (`npm run server` or restart the running
  process) — routes are only as good as the process that's actually
  serving them.
- **`npm run build` writes directly into `dist/`, and the backend serves
  `dist/` from disk on every request — it does not need a restart to pick
  up a frontend rebuild.** If this host already has a `node backend/server.js`
  process running the live site (check `ps aux | grep backend/server.js`
  and `ss -tlnp | grep 3001` before assuming), running `npm run build` here
  **is a production deploy**, not just a local verification step. That's
  usually fine for a real fix, but say so plainly when you do it — don't
  let "I rebuilt to verify" quietly double as "I shipped this to
  antseed-zh.com."
- Don't start a second `node backend/server.js` on the same port to "test"
  something — if a production instance is already running, a second
  `listen()` call on the same port will not bind (it fails silently behind
  the running instance rather than erroring loudly), and either way you
  now have an extra process attached to the same SQLite file for no
  reason. Test against the already-running instance, or stop it first if
  you genuinely need a clean restart (and say so).

## Commit & push policy

Same as the main AntSeed monorepo's convention: **don't commit or push
unless explicitly asked.** Make the edits, verify them (build/typecheck/
whatever applies), and leave the result in the working tree for review.
This repo has repeatedly carried substantial real work across multiple
uncommitted sessions — that's the expected, deliberate workflow here, not
a sign of forgotten cleanup.

## When you're done

Update `notes/dev-plan.md`: remove items you closed, add anything new you
found but didn't fix. Keep it accurate rather than letting it accumulate —
a backlog nobody trusts is worse than no backlog.
