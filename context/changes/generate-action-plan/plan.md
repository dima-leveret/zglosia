# Generate Action Plan (S-03) Implementation Plan

## Overview

Roadmap slice **S-03** — the product's north star (US-01, FR-011, FR-012). An authenticated
owner presses one button, the app feeds their company's submissions plus their company
profile to an LLM, and gets back a two-part artifact: recurring problems ranked by weight,
and concrete action steps tied to those problems. The owner reads it, then saves it to the
company account.

The requirement that shapes every decision below is the anti-hallucination NFR: *"Wygenerowany
plan działań jest wyraźnie ugruntowany w faktycznych zgłoszeniach firmy — każdy wyłoniony
problem da się powiązać z realnymi zgłoszeniami, a nie ze zmyślonymi treściami."* This plan
makes that a database guarantee rather than a prompt instruction. Every problem carries
foreign keys to the actual `submissions` rows it came from, and the save path is a
`security definer` RPC that can only write citations which resolve to the caller's own
submissions. A fabricated citation cannot be persisted, no matter what the model returns or
what a tampered client posts back.

## Current State Analysis

Everything upstream is done and was built anticipating this slice. Three constants exist
today *only* because of S-03, and their doc comments say so:

- `SUBMISSION_CONTENT_MAX = 2000` — "Caps chosen as an S-03 prompt-token budget, not as a
  cosmetic limit" (`src/lib/validation.ts:43,60`), mirrored by the
  `submissions_content_bounds` CHECK so a direct PostgREST call cannot exceed it.
- `SUBMISSION_LIST_LIMIT = 100` — "the owner's next action is *generate a plan from all of
  these*, not *page through them*" (`src/lib/dal.ts:55`).
- `CompanyProfileSchema`'s four fields — "shaped as company context for the S-03 action-plan
  prompt: industry and location change which improvements are even plausible"
  (`src/lib/validation.ts:80`).

Together these bound the worst-case prompt input at 100 × 2000 chars of submissions plus one
company profile — a known, fixed ceiling, not an open-ended context problem.

The isolation contract is a reusable template, stated as such:
`supabase/migrations/20260804171802_submission_intake.sql:5` — *"The isolation contract
established here is what S-03 (action plans), S-04 and S-06 inherit, so the policy shape
below is a template, not a one-off."* That shape is: `revoke all` first, then narrowest verb
and narrowest column set, then RLS policies whose predicates wrap `public.current_company_id()`
in a subselect to force a single InitPlan evaluation per statement.

`enforce_form_submission_rate()` (`supabase/migrations/20260809151843_public_submission_form.sql:113-148`)
is a working precedent for a `BEFORE INSERT` cap trigger, including the choice of a trigger
over a `with check` subquery ("a `with check` subquery counting rows on the table being
inserted into has murky visibility semantics") and the `PT429` SQLSTATE that PostgREST maps
onto HTTP 429 so the caller can distinguish throttled from failed without string-matching.

**What is missing entirely:** any LLM dependency (`package.json` has none), any
`OPENROUTER_API_KEY` (`.env.local` holds only Supabase keys plus `ZGLOSIA_SMTP_PASSWORD`),
any table for plans, and any route under `/dashboard/plans`.

### Key constraints discovered

- **supabase-js has no transaction API.** The chosen storage shape spans four tables. A
  sequence of separate inserts can leave a plan header with no problems if one fails midway.
  This is why the save path is a single RPC.
- **AI SDK v6 deprecates `generateObject`.** Per the v6 migration guide: *"`generateObject`
  and `streamObject` have been deprecated. They will be removed in a future version."* The
  current API is `generateText({ model, output: Output.object({ schema }) })`, the result
  property is `output` (not `object`), and schema-mismatch throws `NoObjectGeneratedError`.
- **`.env.local` is what `npm run dev` reads and what `vitest.config.ts` loads** via
  `loadEnv` with an empty prefix. DB-touching suites refuse a non-local host
  (`tests/support/require-local-db.ts`), and test credentials belong in `.env.test.local`.
- **Server Actions are POSTs to their own route**, so `src/proxy.ts`'s matcher does not guard
  them — `verifySession()` inside the action is the boundary, as every existing action
  documents.

## Desired End State

An owner with submissions opens the dashboard, presses **Generate action plan**, and watches
a progress indicator advance through named stages. Within a minute they are looking at a
Polish-language plan: a ranked list of recurring problems, each showing which of their own
submissions it came from, and a set of concrete action steps. They press **Save** and the
plan lands on their account, findable afterwards at its own URL. Or they press **Discard**
and nothing is written.

An owner with zero submissions sees an explanation instead of a button. An owner with one to
four sees the button plus an honest note that the result may be thin.

Verification: `npm run test:remote` proves the plan tables are reachable only by their owning
company, that a citation naming another company's submission is refused by the database, and
that the eleventh generation in a day raises `PT429`. A manual live run produces a real plan
whose every cited submission is one the owner actually has.

## What We're NOT Doing

- **Plan list, edit, delete** — FR-013 and FR-014 are S-04. This slice ships one read-only
  saved-plan page so a saved plan is findable (the FR-012 acceptance criterion) and nothing
  more.
- **Editing before save.** Review is read + accept/discard. The PRD marks edit-before-save as
  a secondary criterion explicitly "niewystarczające samo w sobie", and building an editor
  now against an unsaved in-memory shape would be rewritten once S-04 defines editing against
  real rows.
- **Streaming partial results.** Progress is a staged pending state, not `streamText`.
- **Regeneration, versioning, plan comparison.** No `supersedes` column, no diffing.
- **Retry on failure.** A failed or timed-out generation surfaces an error; the owner presses
  the button again. No automatic retry, no backoff, no queue.
- **Notifications, exports, PDF.** PRD non-goals or unrequested.
- **Per-submission plans.** PRD §Non-Goals — plans are collective only.
- **Observability tooling.** Parked in the roadmap; `console.error` matches every existing path.
- **Cleanup of ledger rows.** The `plan_generations` table grows; pruning is not this slice.

## Implementation Approach

Five phases, database-first, mirroring the order every prior slice used: schema and privileges
land and are proven before any application code depends on them.

The controlling idea is that **the application is an honest caller, not a boundary** — the
phrase `context/changes/public-submission-form/plan-brief.md` uses. Two rules that matter are
enforced in Postgres and would hold against a direct PostgREST call with a leaked key:

1. **Grounding.** `save_action_plan()` inserts citations with
   `insert … select … where company_id = current_company_id()`, so a citation naming a
   submission the caller does not own simply produces no row. The RPC then compares the
   number of citations requested against the number inserted and aborts if they differ.
2. **Spend.** A `plan_generations` row is written *before* the model is called, and its
   `BEFORE INSERT` trigger raises `PT429` past the daily cap. Because review-then-save means
   generating and saving are separate, the cap must bind the generation — capping saves would
   leave generate-and-discard unbounded, which is exactly the loop a stuck retry falls into.

The generation path itself is a Server Action returning the validated plan as its value.
`useActionState` surfaces it to a review component; a second Server Action saves it. The
plan travels the wire twice, and the save path re-derives every guarantee from scratch, so
the round trip is not a trust boundary.

## Critical Implementation Details

**Ordering — the ledger row precedes the model call.** Insert into `plan_generations` first,
*then* call the model. Inserting afterwards means a caller looping on a request that dies
mid-flight is never counted and the cap never binds. The row is written for every attempt
including ones that go on to fail; that is the point.

**`Output.object` result property.** In AI SDK v6 the structured result is `result.output`,
not `result.object`. Reading `.object` yields `undefined` and every field validates as
missing — a silent failure that looks like a bad model rather than a wrong property name.

**Citation drop happens before the save, not during it.** The generation action discards
problems whose citations are all invalid and logs the drop. If every problem is dropped, the
generation fails outright rather than returning an empty plan — a plan with zero problems is
not a plan. The RPC's own check is the second, independent layer, not the first.

**Two Polish/English boundaries in one feature.** Model output is Polish; UI chrome, error
messages, and log lines are English, extending the split S-06 documented. The prompt must
pin output language explicitly — submissions may be short enough that the model defaults to
English.

---

## Phase 1: Schema, isolation & save RPC

### Overview

One migration creating five tables, their privileges and policies, the generation cap
trigger, and the atomic save RPC. It must leave the database working on its own
(`context/foundation/lessons.md` — "Grants ship in the migration that creates the object").

### Changes Required:

#### 1. Plan storage tables

**File**: `supabase/migrations/<timestamp>_generate_action_plan.sql`

**Intent**: Create the relational shape for a saved plan so that grounding is expressible as
foreign keys rather than opaque JSON, and so S-04's per-item editing becomes ordinary row
updates.

**Contract**: Four tables plus one ledger.

- `public.action_plans` — `id uuid pk`, `company_id uuid not null references companies(id) on delete cascade`,
  `summary text not null`, `created_at timestamptz not null default now()`. The header. No
  `updated_at` and no touch trigger in this slice — nothing updates a plan until S-04, and an
  unused trigger is the kind of speculative surface `submission_intake` explicitly refused.
- `public.plan_problems` — `id uuid pk`, `plan_id uuid not null references action_plans(id) on delete cascade`,
  `rank integer not null`, `title text not null`, `rationale text not null`. `rank` carries
  the priority ordering FR-011 requires; add `unique (plan_id, rank)` so two problems cannot
  claim the same position.
- `public.plan_problem_submissions` — `problem_id uuid not null references plan_problems(id) on delete cascade`,
  `submission_id uuid not null references submissions(id) on delete cascade`, primary key on
  the pair. This table *is* the NFR. `on delete cascade` on `submission_id` is deliberate:
  when an owner deletes a submission (FR-009), its citations vanish rather than dangling, and
  a problem can legitimately end up with none — the plan records what was true when generated.
- `public.plan_actions` — `id uuid pk`, `problem_id uuid not null references plan_problems(id) on delete cascade`,
  `position integer not null`, `content text not null`, `unique (problem_id, position)`. Steps
  hang off problems, not off the plan, which is what makes "powiązanych z wyłonionymi
  problemami" (PRD §Business Logic) structural.

Length CHECKs on every text column, following `submissions_content_bounds`. Zod is not a
boundary here either.

#### 2. Generation ledger and cap

**File**: same migration

**Intent**: Record every generation attempt before the model is called, and cap attempts per
company per day so a paid API behind a button cannot run away.

**Contract**: `public.plan_generations` — `id uuid pk`, `company_id uuid not null references companies(id) on delete cascade`,
`created_at timestamptz not null default now()`. Index on `(company_id, created_at desc)` to
serve the count. A `BEFORE INSERT` trigger `enforce_plan_generation_rate()` counting rows for
the company in the last 24 hours and raising `PT429` past the cap, modelled directly on
`enforce_form_submission_rate()` (`20260809151843_public_submission_form.sql:113`) —
`security definer`, `set search_path = ''`, threshold and interval named together in one
place so they cannot drift. Cap: **10 per company per day**.

#### 3. Privileges

**File**: same migration

**Intent**: Grant only the verbs the application actually exercises, on only the columns it
writes — the rule `context/foundation/lessons.md` records twice.

**Contract**: `revoke all on <each table> from anon, authenticated` first — load-bearing, not
a no-op, because the linked project auto-exposes new tables and would otherwise have granted
ALL before any grant below runs (`20260804171802_submission_intake.sql:59-71` explains this
at length).

Then, for `authenticated`: `select` on all five tables. **No insert grant on any of the four
plan tables** — all writes go through the `security definer` RPC, so the role never needs to
insert directly. `insert (company_id)` on `plan_generations` only. No `update`, no `delete`
anywhere — S-04 adds what FR-014 needs, this slice does not pre-grant it.

`anon` gets nothing at all on any of these tables.

#### 4. RLS policies

**File**: same migration

**Intent**: Scope every read to the caller's own company, inheriting the S-02 template.

**Contract**: RLS enabled on all five tables. `select` policies for `authenticated` only.
`action_plans` and `plan_generations` predicate directly on
`company_id = (select public.current_company_id())`. `plan_problems`, `plan_actions` and
`plan_problem_submissions` are one and two joins removed from `company_id`, so their policies
predicate on an `exists` against the parent chain, each wrapping `current_company_id()` in a
subselect for the same InitPlan reason the S-02 policies document. One `insert` policy on
`plan_generations` with `check (company_id = (select public.current_company_id()))`.

#### 5. Atomic save RPC

**File**: same migration

**Intent**: Make saving a plan one transaction, and make the grounding guarantee a property of
the database rather than of the calling code.

**Contract**: `public.save_action_plan(p_summary text, p_problems jsonb) returns uuid`,
`security definer`, `volatile`, `set search_path = ''`, `revoke all … from public`,
`grant execute … to authenticated`.

It resolves `current_company_id()` itself and raises if null — the company is never taken
from an argument, the invariant every existing action documents. It inserts the header, then
each problem, then each problem's actions, then the citations via
`insert … select … from unnest(...) where submission_id in (select id from public.submissions where company_id = v_company_id)`.

The load-bearing part: after inserting citations for a problem it compares `GET DIAGNOSTICS`
row count against the number of ids supplied, and raises on a mismatch. That is what turns
"the client posted a citation for a submission it does not own" into an aborted transaction
rather than a silently thinner plan. It also raises if `p_problems` is empty or if any
problem ends with zero citations.

#### 6. Regenerated types

**File**: `src/lib/supabase/database.types.ts`

**Intent**: Pick up the five new tables and the RPC signature so the application is typed
against the real schema.

**Contract**: Regenerate via the Supabase CLI. `Database['public']['Functions']['save_action_plan']`
must appear with its argument and return types.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly from empty: `supabase db reset`
- Migration is applied remotely: `supabase migration list --linked` shows a remote timestamp
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Regenerated `database.types.ts` contains all five tables and `save_action_plan`

#### Manual Verification:

- The five tables are visible in Supabase Studio with RLS enabled on each
- `save_action_plan` appears under Database → Functions

**Implementation Note**: `supabase db reset` against an empty database is the only thing that
proves the grants — `lessons.md` records that this criterion was ticked once without being
run, and the gap stayed invisible for three days. Do not infer it from the linked project
working. Push before proceeding: a migration in the repo is not a migration in the database.

---

## Phase 2: Database contract tests

### Overview

Assert the Phase 1 privilege surface behaviourally, in the style of `tests/schema.test.ts` —
positive control first, then each denial on its own error code.

### Changes Required:

#### 1. Plan schema contract suite

**File**: `tests/plans.test.ts`

**Intent**: Prove the isolation, grounding and cap guarantees hold against a real database
and a real anon-key session, not just in the migration's prose.

**Contract**: Follows the existing harness exactly — `requireLocalDb`, a service-role `admin`
client for setup, an anon-key `ownerDb` client carrying a real session so grants and RLS both
apply, users created and deleted per suite. Assertions:

- *Positive control*: `save_action_plan` with valid problems and citations returns a uuid, and
  the owner can read back the plan, its problems, its actions and its citations.
- Direct `insert` into `action_plans` by `authenticated` is refused (`42501`) — proves writes
  are RPC-only.
- `update` and `delete` on all four plan tables are refused (`42501`) — proves S-04's surface
  is genuinely absent.
- A second owner cannot read the first owner's plan, problems, actions or citations (zero rows).
- `save_action_plan` citing a *second owner's* submission id aborts and writes nothing —
  the grounding guarantee. Assert the plan count is unchanged afterwards.
- `save_action_plan` with an empty problem list, and with a problem carrying zero citations,
  both raise.
- Deleting a cited submission removes the citation row and leaves the problem intact.
- The 11th `plan_generations` insert in a day raises `PT429`; the 10th succeeds.
- `anon` is refused `select` on all five tables (`42501`).

### Success Criteria:

#### Automated Verification:

- Suite passes against a local database: `npm run test:remote`
- Full suite still green: `npm run test`
- Linting passes: `npm run lint`

#### Manual Verification:

- Each denial asserts a specific SQLSTATE, not an empty array — an empty array is also what a
  granted select with no matching policy returns, so it would pass for the wrong reason

---

## Phase 3: Generation path

### Overview

The LLM integration: dependencies, provider wiring, prompt, output schema, abort, ledger, and
citation verification. Everything here is testable with a stubbed model.

### Changes Required:

#### 1. Dependencies and environment

**File**: `package.json`, `.env.local`

**Intent**: Add the AI SDK and the OpenRouter provider, and pin the model in configuration so
swapping it is not a code change.

**Contract**: `npm i ai @openrouter/ai-sdk-provider`. New env vars `OPENROUTER_API_KEY` and
`ZGLOSIA_PLAN_MODEL` (an OpenRouter model id). Neither is `NEXT_PUBLIC_`-prefixed — both are
server-only. Both must also be set in the Vercel project before deploy.

#### 2. Plan output schema

**File**: `src/lib/plan-schema.ts`

**Intent**: Define the structure the model must return, and the bounds it must respect, in one
place shared by the generator and its tests.

**Contract**: A Zod v4 schema: `summary` string, `problems` array of `{ title, rationale,
submissionIndexes: number[], actions: string[] }`, with min/max on every array and length caps
on every string that match the database CHECKs from Phase 1.

`submissionIndexes` — not raw uuids. The prompt presents submissions as a numbered list and
the model returns indexes into it. A model asked to echo uuids will corrupt them character by
character; an integer in a small range is something it can get right, and anything outside the
range is trivially detectable. The generator maps indexes back to real ids server-side.

#### 3. Prompt builder

**File**: `src/lib/plan-prompt.ts`

**Intent**: Turn a company profile and a list of submissions into the system and user messages,
deterministically, so the prompt is unit-testable without a model.

**Contract**: A pure function from `{ company, submissions }` to `{ system, prompt }`. The
system message pins: Polish output; problems ranked by frequency and urgency; every problem
must cite at least one submission index; actions must be concrete and tied to their problem;
nothing may be invented that is not supported by a cited submission. Submissions are rendered
as a numbered list, index → content. Company profile fields are included as context.

#### 4. Generation action

**File**: `src/app/dashboard/plans/actions.ts`

**Intent**: The Server Action the button calls: authenticate, gate on submission count, record
the attempt, call the model under an abort budget, verify citations, return the plan.

**Contract**: `generatePlan(prevState, formData): Promise<GenerateState>` where `GenerateState`
carries either a `plan` (the verified, id-resolved artifact) or a `message`. Sequence:

1. `verifySession()`, then `getCompany()` — company scope from the session, never the request.
2. Read submissions via the DAL. Zero → return the empty-state message without touching the
   ledger or the model.
3. Insert one `plan_generations` row. `PT429` here → return the throttled message. **Before
   the model call**, for the reason in Critical Implementation Details.
4. `generateText({ model, output: Output.object({ schema }), system, prompt, abortSignal })`
   with a 60-second `AbortSignal.timeout`. Catch `NoObjectGeneratedError` separately from
   abort and from transport failure so each maps to its own message.
5. Map `submissionIndexes` back to real submission ids, dropping any index outside the range.
   Drop any problem left with zero citations, logging each drop. If every problem is dropped,
   return the failure message rather than an empty plan.
6. Return the plan. Nothing is written to the plan tables here.

#### 5. Messages

**File**: `src/app/dashboard/plans/messages.ts`

**Intent**: Outcome strings shared between the actions and the components, in a module without
`'use server'` — the constraint `src/app/dashboard/submissions/messages.ts` documents.

**Contract**: English constants for generation failed, timed out, throttled, no submissions,
saved, save failed, discarded.

#### 6. Generation tests

**File**: `tests/plan-generation.test.ts`

**Intent**: Prove the verification logic — the part that carries the NFR — without spending
money or depending on a model's mood.

**Contract**: Pure-function tests over the prompt builder and the citation-verification step,
driven by hand-written model outputs: valid output passes through; an out-of-range index is
dropped; a problem whose indexes are all out of range is dropped; an output where every
problem is dropped produces a failure, not an empty plan; the prompt contains every submission
exactly once and pins Polish.

### Success Criteria:

#### Automated Verification:

- Generation tests pass: `npm run test`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- `OPENROUTER_API_KEY` and `ZGLOSIA_PLAN_MODEL` are absent from git: `git check-ignore .env.local`

#### Manual Verification:

- A live call with real submissions returns Polish output whose cited indexes are all in range
- Generation completes inside the 60-second budget on a realistic set (~30 submissions)

---

## Phase 4: Review & save UI

### Overview

The owner-facing surface: the button and its gating, staged progress, the review screen, and
the save/discard decision.

### Changes Required:

#### 1. Save action

**File**: `src/app/dashboard/plans/actions.ts`

**Intent**: Persist a reviewed plan by calling the RPC, re-deriving every guarantee from the
session rather than trusting the posted payload.

**Contract**: `savePlan(prevState, formData)` — parses the posted plan with a Zod schema
(structure only; the citation guarantee is the RPC's job), calls `save_action_plan`, and
`redirect`s to the saved plan on success. `revalidatePath('/dashboard')`. Errors from the RPC
map to the generic save-failed message; the specific SQL error is logged, not surfaced.

#### 2. Generate + review component

**File**: `src/app/dashboard/plans/plan-generator.tsx`

**Intent**: Drive generation, show progress that satisfies the NFR, then render the result for
review with save and discard.

**Contract**: `'use client'`, `useActionState(generatePlan, undefined)`. While `isPending`, a
progress indicator advancing through named English stages on a timer — the NFR wants
continuous visible progress, and the stages must not claim more precision than exists. When
the action returns a plan, the form is replaced by the review: summary, ranked problems each
showing its cited submissions verbatim, and actions per problem. Save posts the plan to
`savePlan`; discard clears local state and returns to the button.

The cited submissions are what make the grounding visible to the owner — showing a problem
without the customer words behind it is exactly the "kolejne narzędzie do statystyk" the
roadmap says the product must not be.

#### 3. Plans page and gating

**File**: `src/app/dashboard/plans/page.tsx`

**Intent**: Host the generator and enforce the threshold decision server-side.

**Contract**: Server Component. Reads `getSubmissionCount()` and `getCompany()`. At zero
submissions, renders an empty state explaining why generation is unavailable and links to
`/dashboard/submissions` — no button (PRD acceptance: *"akcja jest niedostępna lub pokazuje
stan pusty z wyjaśnieniem"*). Between one and four, renders the button plus a note that the
plan may be thin. At five or more, the button alone. An incomplete company profile shows the
same amber prompt `src/app/dashboard/page.tsx:54` uses, without blocking.

#### 4. Dashboard entry point

**File**: `src/app/dashboard/page.tsx`

**Intent**: Make the north-star action reachable.

**Contract**: A link to `/dashboard/plans` alongside the existing three, with copy that
reflects submission count the way the existing links do.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Full suite green: `npm run test`

#### Manual Verification:

- With zero submissions the action is unavailable and explains why
- With one to four the warning appears and generation still works
- Progress is visible continuously from the moment the button is pressed — nothing looks hung
- Discard writes nothing: the plan count is unchanged afterwards
- Save redirects to the saved plan and it survives a refresh

---

## Phase 5: Saved plan view & acceptance

### Overview

The minimal read-only surface that satisfies "można zapisać i odnaleźć później", plus the one
live end-to-end run that is this slice's real acceptance test.

### Changes Required:

#### 1. Saved plan reader

**File**: `src/lib/dal.ts`

**Intent**: Read one saved plan with its problems, actions and cited submissions, RLS-scoped.

**Contract**: `getActionPlan(id)` following the filter-free read convention the module
documents — RLS scopes the query, no explicit company filter on the read path. Returns the
nested shape via a single embedded select. Row type derived from `Database`, not hand-written,
for the reason `SubmissionListRow` documents.

#### 2. Saved plan page

**File**: `src/app/dashboard/plans/[planId]/page.tsx`

**Intent**: Render a saved plan so it is findable after generation.

**Contract**: Server Component awaiting `params`. Validates the id as a uuid before querying.
Not found or not the caller's → the same generic treatment other paths use, never a message
distinguishing "does not exist" from "not yours" (the membership-oracle reasoning in
`src/app/dashboard/submissions/messages.ts:18`). Read-only: no edit, no delete — S-04.

#### 3. Live acceptance run

**File**: — (manual)

**Intent**: Exercise the real model once, end to end, which is the only way the non-deterministic
half of this slice gets verified.

**Contract**: With a real company profile and 15–30 real submissions, generate, review, save,
reload. Confirm the plan is Polish, the problems are genuinely recurring themes rather than a
restatement of individual submissions, and every citation names a submission that exists.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Full suite green: `npm run test` and `npm run test:remote`

#### Manual Verification:

- A saved plan is reachable at its URL after a full page reload and a re-login
- A second owner requesting that URL cannot see it
- The live run produces a plan whose every cited submission is one the owner actually has
- The plan reads as advice the owner could act on — not a restatement of the submissions

---

## Testing Strategy

### Unit Tests

- Prompt builder: every submission appears exactly once and numbering is stable; Polish is pinned
- Citation verification: out-of-range indexes dropped; all-invalid problems dropped; total
  collapse produces failure rather than an empty plan
- Output schema: rejects missing citations, out-of-bounds string lengths, empty problem lists

### Integration Tests (real Postgres)

- The full Phase 2 contract suite: grants, cross-tenant denial, RPC grounding refusal,
  cascade on submission delete, `PT429` at the cap

### Manual Testing Steps

1. With zero submissions, open `/dashboard/plans` — expect an explanation, no button
2. Add three submissions, generate — expect the thin-plan note, and a working plan
3. Generate with ~20 submissions and watch the indicator from press to result
4. Discard, then verify no plan row was created
5. Generate again, save, reload the saved plan URL
6. Log in as a second owner and request that URL — expect nothing
7. Delete a submission cited by a saved plan and reload the plan — expect it to render with
   one fewer citation, not to error
8. Generate 11 times in a day — expect the throttled message on the 11th

## Performance Considerations

The prompt is bounded by construction at 100 submissions × 2000 chars plus one profile — a
fixed ceiling, not an open-ended context problem. The 60-second abort sits well inside
Vercel's 300s function default, so a timeout surfaces as this app's own message rather than a
platform error; `infrastructure.md` names that platform error as its top-likelihood risk.

The cap count is served by the `(company_id, created_at desc)` index on `plan_generations`.
The saved-plan read is a single embedded select, not N+1 across four tables.

## Migration Notes

One migration, additive only. No existing table is altered and no data is backfilled — the
four plan tables and the ledger start empty. Rollback is code-only: reverting the deploy
leaves the tables in place and unread, since nothing else references them.

The cascade chain is worth stating once: deleting an auth user cascades to `companies`, which
cascades to `submissions`, `action_plans` and `plan_generations`, which cascade onward to
problems, actions and citations. The RODO erasure path (`src/lib/account-deletion.ts`) keeps
working without modification, and plans are erased with everything else — the correct reading
of the NFR, and the same conclusion `submission_intake` reached.

## References

- Roadmap slice: `context/foundation/roadmap.md` §S-03
- Isolation template: `supabase/migrations/20260804171802_submission_intake.sql:5,59-116`
- Cap trigger precedent: `supabase/migrations/20260809151843_public_submission_form.sql:113-148`
- Grant rules: `context/foundation/lessons.md`
- DB test harness: `tests/schema.test.ts:20-79`
- Prompt-budget constants: `src/lib/validation.ts:43,60,80`; `src/lib/dal.ts:55`
- Prior slice for style: `context/changes/public-submission-form/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Schema, isolation & save RPC

#### Automated

- [ ] 1.1 Migration applies cleanly from empty: `supabase db reset`
- [x] 1.2 Migration applied remotely: `supabase migration list --linked` shows a remote timestamp
- [x] 1.3 Type checking passes: `npx tsc --noEmit`
- [x] 1.4 Linting passes: `npm run lint`
- [x] 1.5 Regenerated `database.types.ts` contains all five tables and `save_action_plan`

> 1.1 NOT RUN — no Docker runtime on this machine, so there is no local Supabase to
> reset from empty. Deliberate operator decision at implementation time, not an
> oversight. The exposure is exactly the one `context/foundation/lessons.md` records:
> the linked project auto-exposes new tables, so a missing `revoke` would look correct
> there. The compensating control is the Phase 2 contract suite, which asserts every
> denial the revoke block is responsible for behaviourally (`42501` on direct insert,
> update, delete, and on every anon read). Tick this once a local Supabase exists.

#### Manual

- [x] 1.6 Five tables visible in Supabase Studio with RLS enabled on each
- [x] 1.7 `save_action_plan` appears under Database → Functions

### Phase 2: Database contract tests

#### Automated

- [ ] 2.1 Suite passes against a local database: `npm run test:remote`
- [ ] 2.2 Full suite still green: `npm run test`
- [ ] 2.3 Linting passes: `npm run lint`

#### Manual

- [ ] 2.4 Each denial asserts a specific SQLSTATE, not an empty array

### Phase 3: Generation path

#### Automated

- [ ] 3.1 Generation tests pass: `npm run test`
- [ ] 3.2 Type checking passes: `npx tsc --noEmit`
- [ ] 3.3 Linting passes: `npm run lint`
- [ ] 3.4 Secrets absent from git: `git check-ignore .env.local`

#### Manual

- [ ] 3.5 A live call returns Polish output whose cited indexes are all in range
- [ ] 3.6 Generation completes inside the 60-second budget on ~30 submissions

### Phase 4: Review & save UI

#### Automated

- [ ] 4.1 Type checking passes: `npx tsc --noEmit`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Build succeeds: `npm run build`
- [ ] 4.4 Full suite green: `npm run test`

#### Manual

- [ ] 4.5 Zero submissions: action unavailable with an explanation
- [ ] 4.6 One to four submissions: warning shown, generation still works
- [ ] 4.7 Progress visible continuously from press to result
- [ ] 4.8 Discard writes nothing — plan count unchanged
- [ ] 4.9 Save redirects to the saved plan and it survives a refresh

### Phase 5: Saved plan view & acceptance

#### Automated

- [ ] 5.1 Type checking passes: `npx tsc --noEmit`
- [ ] 5.2 Linting passes: `npm run lint`
- [ ] 5.3 Build succeeds: `npm run build`
- [ ] 5.4 Full suite green: `npm run test` and `npm run test:remote`

#### Manual

- [ ] 5.5 Saved plan reachable at its URL after reload and re-login
- [ ] 5.6 A second owner cannot see that URL
- [ ] 5.7 Live run: every cited submission is one the owner actually has
- [ ] 5.8 The plan reads as actionable advice, not a restatement of submissions
