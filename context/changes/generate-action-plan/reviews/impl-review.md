<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Generate Action Plan (S-03)

- **Plan**: `context/changes/generate-action-plan/plan.md`
- **Scope**: Phases 1–5 of 5 (full plan)
- **Date**: 2026-08-14
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 3 observations
- **Triage**: complete — 4 fixed (F3, F4, F5, F6), 2 skipped (F1, F2)

## Post-triage verification

Run after every fix landed: `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build`
succeeds with both plan routes listed · `npm run test:remote` **155 passed / 7 files** (up
from 154 — the new `PLAN_PROBLEMS_MAX` contract test) · `supabase migration list --linked`
shows `20260814184500` and `20260814185200` both applied remotely.

Two migrations were added during triage and are applied to the linked project, so
`context/foundation/lessons.md`'s rule — *"a review finding is not closed when the migration
is committed, it is closed when `supabase migration list --linked` shows it applied
remotely"* — is satisfied for both. Neither is committed to git yet.

F1 and F2 were skipped by operator decision. Both bear on deploy readiness rather than on the
code: the shipping model for the north-star output is still unverified (F1) and the two
required env vars are named in no committed file (F2). They are the open items to settle
before this slice deploys.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Verification run during this review

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `npm run lint` | PASS (no output) |
| `npm run build` | PASS — `/dashboard/plans` and `/dashboard/plans/[planId]` both listed as routes |
| `npm run test` | Exits non-zero: 83/83 non-DB tests pass; 3 DB suites refused by `require-local-db.ts` because `.env.local` points at the hosted project. Confirmed to be the documented 2.2 cause and nothing else. |
| `npm run test:remote` | PASS — 154 passed, 7 files |
| `supabase migration list --linked` | Both `20260814132833` and `20260814134807` show a remote timestamp |
| Diff vs. plan file list | Every planned file present; no unplanned source file outside the documented `getLatestActionPlan` addition |

The database guarantees the plan is built on were verified as implemented, not just described:
`save_action_plan()` resolves the company from `current_company_id()` and never from an
argument; the citation insert filters on `s.company_id = v_company_id` and the
`GET DIAGNOSTICS` count comparison aborts the transaction on any id that does not resolve;
the ledger row is written before the model call; `revoke all` precedes every grant; no
insert/update/delete grant exists on the four plan tables. `tests/plans.test.ts` asserts all
of it behaviourally with specific SQLSTATEs, and goes past the plan's Phase 2 contract
(mixed valid/foreign citations, self-supplied `created_at` and `id` on the ledger, anon
EXECUTE at the grant layer).

## Findings

### F1 — Phase 5 acceptance ticked on the free model the plan disqualified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `.env.local` (`ZGLOSIA_PLAN_MODEL`); `context/changes/generate-action-plan/plan.md:938` (5.8)
- **Detail**: The Phase 4 note sets `ZGLOSIA_PLAN_MODEL=nvidia/nemotron-3-super-120b-a12b:free`
  for the manual pass and states the condition explicitly: *"Switch back to a paid model
  before Phase 5's acceptance run. 5.8 ('the plan reads as actionable advice, not a
  restatement') is a judgement on model quality, and passing it on a free model would not be
  evidence for what ships."* `.env.local` still reads
  `ZGLOSIA_PLAN_MODEL=nvidia/nemotron-3-super-120b-a12b:free`, and Phase 5's notes never
  record a switch. 5.5–5.8 are all ticked at `1a5c85b`. 5.8 is therefore ticked against the
  plan's own stated precondition — the one criterion in this slice that judges the north-star
  output rather than the plumbing.
- **Fix A ⭐ Recommended**: Set a paid model in `.env.local`, re-run 5.7 and 5.8 once against a
  real 15–30 submission set, and record the model id and the outcome in the Progress note.
  - Strength: Restores the evidence the criterion was written to produce, and pins in writing
    which model the quality judgement actually applies to — the plan already pinned the model
    in configuration precisely so this is an env edit, not a code change.
  - Tradeoff: Costs one paid generation and requires OpenRouter credit; the Phase 4 note
    records a 402 because the account balance affords ~2,666 tokens against a reserved
    ceiling of 64,000.
  - Confidence: HIGH — the plan states the precondition verbatim and the config demonstrably
    does not meet it.
  - Blind spot: Whether the free model's output was in fact poor is unknown; this may confirm
    5.8 rather than overturn it.
- **Fix B**: Leave the tick and amend the Progress note to say 5.8 was judged on
  `nemotron-3-super-120b-a12b:free`, and record the paid-model run as a follow-up before deploy.
  - Strength: Costs nothing now and keeps the record honest, which is the part that matters
    for a later reader.
  - Tradeoff: The slice ships with its only output-quality criterion unverified for the model
    that will actually run in production.
  - Confidence: MEDIUM — acceptable only if the shipping model is decided later anyway.
  - Blind spot: Have not verified which model the Vercel project is configured with (see F2).
- **Decision**: SKIPPED

### F2 — `ZGLOSIA_PLAN_MODEL` exists in no env template or doc, and Vercel config is unverified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: repository root (no `.env.example`); `src/app/dashboard/plans/actions.ts:139`
- **Detail**: Phase 3's contract states *"Both must also be set in the Vercel project before
  deploy."* Nothing in the repo records that requirement outside the plan itself:
  `infrastructure.md:118` names `OPENROUTER_API_KEY` in a generic list and never mentions
  `ZGLOSIA_PLAN_MODEL`, and there is no `.env.example`. `.env.local` is gitignored (verified),
  which is correct — but it means the only place the new variable's *name* is written down is
  a plan file. `generatePlan()` handles the absence gracefully (`actions.ts:144-149` logs and
  returns `PLAN_GENERATION_FAILED` rather than throwing at import), so a deploy missing either
  variable does not crash — the north-star button simply fails every time, with the cause
  visible only in server logs. Vercel's env state could not be checked from here: the Vercel
  CLI is not installed.
- **Fix**: Add a committed `.env.example` (or a section in `AGENTS.md`) listing
  `OPENROUTER_API_KEY` and `ZGLOSIA_PLAN_MODEL` as required server-only vars, and confirm both
  are set in the Vercel project before the deploy that ships this slice.
- **Decision**: SKIPPED

### F3 — The plans page promises a plan built from more submissions than the model is given

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/app/dashboard/plans/page.tsx:110-113`
- **Detail**: The page reads `getSubmissionCount()`, which is an unlimited `count: 'exact',
  head: true` over `submissions` (`src/lib/dal.ts`), and renders *"The plan will be generated
  from your N submissions."* Generation reads `getSubmissions()`, which is capped at
  `SUBMISSION_LIST_LIMIT = 100` and ordered newest-first. With 247 submissions the owner is
  told the plan covers 247 while the model is shown the newest 100. The 100-row cap is a
  deliberate, well-argued prompt-budget decision the plan defends at length; the claim on the
  page is the part that is wrong. `getSubmissions()` already returns `total` alongside
  `submissions`, so the truth is available at both call sites. Nothing about the grounding
  guarantee is affected — every cited submission is still one the owner has.
- **Fix**: Cap the number in the copy at `SUBMISSION_LIST_LIMIT` and say so when the total
  exceeds it — e.g. *"from your most recent 100 of 247 submissions"* — reusing the phrasing
  the submissions list already uses for the same cap.
- **Decision**: FIXED — `src/app/dashboard/plans/page.tsx` now renders "your most recent 100
  of N submissions" once the total exceeds `SUBMISSION_LIST_LIMIT`, mirroring
  `dashboard/submissions/page.tsx:82`. `tsc --noEmit` and `npm run lint` clean afterwards.

### F4 — `save_action_plan()` bounds citations but not plan size, and saves are uncapped

- **Severity**: 📋 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260814132833_generate_action_plan.sql:433` (the
  `for v_problem in select * from jsonb_array_elements(p_problems)` loop)
- **Detail**: The RPC is presented — correctly, for grounding and for tenancy — as a boundary
  that *"would hold against a direct PostgREST call with a leaked key."* Two bounds are
  enforced only in Zod, which such a call skips: `PLAN_PROBLEMS_MAX = 8` /
  `PROBLEM_ACTIONS_MAX = 5` (`src/lib/plan-schema.ts`) have no database counterpart, unlike
  the string caps, which are mirrored as CHECKs. An authenticated owner posting
  `p_problems` with 50,000 elements makes the function loop 50,000 times inside one
  transaction. Separately, `plan_generations` caps generation at 10/day but there is no cap on
  `save_action_plan` calls. The blast radius is confined to the caller's own tenant — every
  problem still needs citations resolving to that company's own submissions — so this is
  self-inflicted, not cross-tenant. It is a gap between what the migration's prose claims and
  what it enforces, not an exploitable isolation hole.
- **Fix**: Add an array-length guard at the top of the RPC (`jsonb_array_length(p_problems) > 8`
  → raise `22023`) mirroring `PLAN_PROBLEMS_MAX`, in the same spirit as the string CHECKs that
  already mirror the Zod caps.
- **Decision**: FIXED — `supabase/migrations/20260814184500_bound_plan_problem_count.sql`
  replaces `save_action_plan()` with the empty check widened to a range check (1–8 problems,
  `22023`), mirroring `PLAN_PROBLEMS_MAX`. The anon revoke and the `authenticated` grant are
  re-asserted in the same file. Applied remotely — `supabase migration list --linked` shows
  `20260814184500` with a remote timestamp. `tests/plans.test.ts` gained
  *"refuses a problem list longer than PLAN_PROBLEMS_MAX"*; `npm run test:remote` is
  155 passed / 7 files (was 154). Lint and `tsc --noEmit` clean.

### F5 — The generation cap can be exceeded under concurrency

- **Severity**: 📋 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260814132833_generate_action_plan.sql:337-349`
- **Detail**: `enforce_plan_generation_rate()` counts rows and then lets the insert proceed.
  Under read-committed, two concurrent inserts can both observe 9 existing rows and both
  succeed, landing at 11. The overshoot is bounded by concurrency, not unbounded — a browser
  tab spamming the button costs a handful of extra model calls past the cap, not a runaway.
  This is not a deviation: `enforce_form_submission_rate()`
  (`20260809151843_public_submission_form.sql:113`) has exactly the same shape, and the plan
  names it as the precedent to model on. Flagged because the property this trigger guards is
  spend against a paid API, where the precedent's is spam volume.
- **Fix**: Accept as-is for this slice and record the ceiling as approximate, or, if the spend
  bound needs to be exact, take a per-company advisory lock (`pg_advisory_xact_lock`) in the
  trigger before counting.
- **Decision**: FIXED — `supabase/migrations/20260814185200_serialize_plan_generation_cap.sql`
  replaces `enforce_plan_generation_rate()` with a
  `pg_catalog.pg_advisory_xact_lock(8303, hashtext(company_id::text))` taken before the count.
  Same-company attempts serialise; different companies take different keys and never contend;
  the `_xact_` variant releases on rollback as well as commit, so an aborted insert cannot
  wedge a company's cap. Threshold and interval unchanged.
  `enforce_form_submission_rate()` deliberately left alone — anon-facing and high-traffic,
  where the exact boundary does not matter and per-company serialisation would add contention
  to the app's only genuinely concurrent write path. Applied remotely
  (`20260814185200` shows a remote timestamp); `npm run test:remote` 155 passed / 7 files,
  including the existing at-the-cap test, which confirms the sequential path is unaffected.

### F6 — `PLAN_SAVED` is exported but never used

- **Severity**: 📋 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/app/dashboard/plans/messages.ts:51`
- **Detail**: `savePlan()` ends in `redirect()`, which throws, so no success message ever
  renders — the module's own doc comment for `SaveState` says exactly this. `PLAN_SAVED` is
  the only constant in the file with no reader. It is also the only one carrying no comment,
  where every sibling explains why it exists — which is what makes it read as a leftover
  rather than a deliberate reservation.
- **Fix**: Delete the constant, or add a one-line comment stating it is reserved for S-04's
  save-in-place path.
- **Decision**: FIXED — kept, with a doc comment recording that it is reserved for S-04's
  save-in-place path (FR-014) and unread today because `savePlan()` ends in `redirect()`.
  It now matches every sibling constant in the file, each of which explains why it exists.

## Pending success criteria (not findings)

Two automated criteria remain unticked, both documented in the plan with the same root cause
and both re-verified during this review:

- **1.1 `supabase db reset`** — no Docker runtime on this machine. This is the one criterion
  `lessons.md` singles out as untickable by inference, and the exposure is real: the linked
  project auto-exposes new tables, so a missing `revoke` would look correct there. The
  compensating control is genuine and was confirmed running — `tests/plans.test.ts` asserts
  `42501` on direct insert, on update, on delete across all four tables, and on every anon
  read, which is the denial surface the revoke block is responsible for. That is a strong
  substitute, not a full one: it proves the privileges are correct on the remote database, not
  that a fresh `db reset` reproduces them.
- **2.2 `npm run test`** — reproduced exactly as documented. 83/83 non-DB tests pass; the
  three DB suites are refused by the environment guard, which is that guard working.

Both are honestly annotated in the Progress section rather than ticked, which is the correct
handling.
