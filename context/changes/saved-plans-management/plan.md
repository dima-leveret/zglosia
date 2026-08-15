# Saved Plans Management (S-04) Implementation Plan

## Overview

Roadmap slice **S-04** (FR-013, FR-014). S-03 landed the storage and a single read-only plan
page reachable through one "latest plan" link. This slice turns that into plan *management*:
an index of every saved plan, whole-plan editing that preserves what the model originally
produced, and deletion.

The write posture from S-03 is kept intact. The four plan tables remain `select`-only for
`authenticated`, with exactly one new exception — `delete` on `action_plans`, which needs no
invariant because a whole-plan delete cannot corrupt anything. Every *structural* write still
goes through a `security definer` RPC, so the guarantees hold against a direct PostgREST call
with a leaked anon key and not merely against a well-behaved Server Action.

## Current State Analysis

**The schema was built for this slice and deliberately stops at its edge.**
`supabase/migrations/20260814132833_generate_action_plan.sql:27-30` states it outright:

> Scope is deliberately narrow. FR-013 (list plans) and FR-014 (edit/delete plans) are S-04, so
> there is no update grant, no delete grant, no updated_at column and no touch trigger anywhere
> in this file. That absence is a decision, not an oversight.

What exists today:

- **Five tables.** `action_plans` (header + `summary`), `plan_problems` (`rank`, `title`,
  `rationale`, `unique (plan_id, rank)`), `plan_actions` (`position`, `content`,
  `unique (problem_id, position)`), `plan_problem_submissions` (the citation join — "THIS TABLE
  IS THE NFR"), and `plan_generations` (the spend ledger, untouched by this slice).
- **Grants**: `select` only on the four plan tables for `authenticated`; nothing at all for
  `anon`. Writes happen exclusively through `save_action_plan(text, jsonb)`.
- **RLS**: `action_plans` predicates on `company_id` directly; the other three walk back up the
  parent chain via `EXISTS`, each wrapping `current_company_id()` in a subselect for the
  InitPlan reason the S-02 policies document. **Select policies only** — a policy without a
  grant is decoration.
- **`getActionPlan(planId)`** (`src/lib/dal.ts:171`) — one embedded round trip down the whole
  chain, ordering applied in JS. Reusable as-is, needs two more columns.
- **`getLatestActionPlan()`** (`src/lib/dal.ts:240`) — documented as a placeholder: *"FR-013
  (przeglądać zapisane plany) is S-04 and gets a real list page there … it is one row rather
  than a surface S-04 would then have to replace."* This slice replaces it.
- **`/dashboard/plans/page.tsx`** — the generator surface: zero-submission empty state, thin-plan
  warning below five, incomplete-profile prompt, `<PlanGenerator />`, and the single latest-plan
  link at the foot.
- **`/dashboard/plans/[planId]/page.tsx`** — read-only, no-oracle 404 (a foreign plan id and a
  nonexistent one render identically), renders the **stored** `rank` rather than array position
  on purpose.
- **`PLAN_SAVED`** (`plans/messages.ts:58`) — reserved and deliberately unread: *"kept for S-04's
  save-in-place edits (FR-014), where a save that stays on the page does need to confirm itself."*
- **Delete UX pattern**: `submissions/submission-row.tsx` — per-row armed state, focus moved to
  Cancel on arming and back to Delete on disarm, a live region that outlives the removed row
  (owned by the parent list, `submission-list.tsx:73-79`).
- **Test suite**: `tests/plans.test.ts` (856 lines) is the S-03 contract suite, run against a
  real Postgres with an anon-key client and a service-role admin client. Its house style: a
  positive control first, then each denial asserted on its own **SQLSTATE** — never on an empty
  array, because "an empty array is also what a GRANTED select with no matching policy returns,
  and the two mean opposite things."

**What is missing:** any write path other than `save_action_plan`, any notion of "this plan was
edited", any list read, and any route that shows more than one plan.

### Key Discoveries

- `public.touch_updated_at()` already exists as a **generic** BEFORE UPDATE trigger function
  (`20260729171332_company_profile.sql:48-60`) — reusable verbatim, no new function needed.
- **`revoke ... from public` does not remove a Supabase default grant to `anon`.**
  `20260814134807_harden_plan_rpc_grants.sql` is an entire migration written because
  `save_action_plan` shipped executable by `anon` despite ending in `revoke all … from public`:
  Supabase default privileges grant EXECUTE **directly to the named roles**, which `from public`
  leaves untouched. The new RPC must carry an explicit `revoke … from anon`.
- **`plan_problems_rank_positive check (rank > 0)`** rules out the usual negate-then-renumber
  trick for dodging `unique (plan_id, rank)`. A positive offset pass is required (see Critical
  Implementation Details).
- `save_action_plan` assigns `rank` and `position` **from array order**, never from a payload
  field — "the ordering is data the caller supplies implicitly, not a field it can contradict."
  `update_action_plan` must keep that contract.
- `plan_problem_submissions` has no surrogate key (PK is `(problem_id, submission_id)`), which
  `tests/plans.test.ts:64-76` already handles with a per-table filter-column map.
- `SUBMISSION_LIST_LIMIT = 100` documents the house position on paging: *"the list is capped
  rather than paginated: the owner's next action is 'generate a plan from all of these', not
  'page through them', so offset links would be scaffolding for a workflow the product does not
  have."* Plans inherit that reasoning, with generation already capped at 10/company/day.
- `PLAN_PROBLEMS_MAX = 8`, `PROBLEM_ACTIONS_MAX = 5` (`plan-schema.ts:42-47`) bound the editor:
  the largest possible form is 8 problems × 5 actions ≈ 50 fields.
- **`lessons.md` bites this slice three times**: grants ship in the migration that creates the
  object; a migration in the repo is not a migration in the database (`supabase db push` +
  `supabase migration list --linked` as evidence); and narrowest verb / narrowest column set —
  the `20260730190000_narrow_company_write_grants.sql` precedent, where table-wide `update` let
  an owner rewrite their own `id` and `created_at`.

## Desired End State

An owner opens **/dashboard/plans** and sees every plan they have saved, newest first, each with
its date, how many problems it holds, and an "edited" marker where they have changed it. They
open one, press **Edit**, fix the wording the model got clumsy, drop the one problem that missed
the point, and save — staying on the page, with a confirmation. The plan now shows when it was
edited and offers a read-only view of what the model originally wrote. A plan they no longer
want is deleted from either the list or the plan's own page behind a two-step confirm.

None of this weakens S-03's guarantees: the citation rows behind each surviving problem are
untouched by editing, the four plan tables remain unwritable by any path other than the two RPCs,
and a plan or a problem belonging to another company is unreachable and unmodifiable — proven by
SQLSTATE in the contract suite, not by an empty result.

**Verification**: `npm run test:remote` passes including the new editing contracts;
`supabase migration list --linked` shows the new migration applied remotely; an owner completes
list → edit → save → view-original → delete end-to-end in the running app.

## What We're NOT Doing

- **Adding problems, actions or citations.** Editing removes and rewrites; it never creates. An
  owner-authored problem would cite nothing, putting an ungrounded row into the table whose
  entire purpose is grounding.
- **Reordering.** `rank` and `position` are set by generation and re-derived on removal; the
  owner cannot promote problem #4 above #2.
- **Editing citations.** `plan_problem_submissions` is written only by `save_action_plan` and is
  never touched by this slice.
- **Version history.** One snapshot of the model's original, not a trail. The owner can compare
  against the generation, not against their own previous edit.
- **Restoring the original.** The original is *viewable*, not a one-click revert.
- **Pagination.** The list is capped, like submissions.
- **Regeneration into an existing plan**, plan export, plan comparison, notes, sharing.
- **Touching `save_action_plan`, `plan_generations`, or the generation path.** The generation cap
  is not changed and editing is not capped — no model call, no spend.
- **Observability tooling** — still parked by the roadmap.

## Implementation Approach

One migration adds the two columns, the one new grant, and the one new function. `update_action_plan`
takes the **whole desired state** of the plan and diffs it against what is stored: ids present in
the payload survive and get their text rewritten, ids absent are deleted, and `rank`/`position`
are re-derived from array order. Removal is therefore "this id was not in the payload" rather than
a separate call — which is what lets a whole-plan save be one transaction, and what makes Cancel
in edit mode a genuine no-op on the database.

The snapshot is built **from the stored rows** at the moment of the first edit, never from the
payload, so it records what the model produced rather than what the client claims it produced.

On the client, the editor is a controlled component holding the plan in React state. Removals are
staged there and applied only on Save. The form posts a single hidden JSON field, exactly as
`PlanReview` already does for `savePlan` — which sidesteps the echo-back problem a 50-field
uncontrolled form would have, since the client state *is* the echo.

## Critical Implementation Details

**Renumbering without tripping the unique constraint.** `plan_problems_rank_unique` is
`unique (plan_id, rank)` and `plan_problems_rank_positive` is `check (rank > 0)`, so the usual
"set to negative, then set to final" trick is unavailable. Renumber in **two passes with a
positive offset**: first `update … set rank = rank + 1000` for every surviving row of the plan,
then assign final ranks `1..N` from array order. The same applies to `plan_actions.position` per
problem. The offset is safe because `PLAN_PROBLEMS_MAX = 8` and `PROBLEM_ACTIONS_MAX = 5` bound
both collections far below it. Getting this wrong produces a `23505` on an edit that removes any
problem other than the last one — the exact case this slice exists for.

**Ordering inside `update_action_plan`.** Snapshot first (while the pre-edit rows are still
intact), then verify ids, then delete, then update text, then renumber. Snapshotting after the
delete would record the post-edit state as the "original".

**The snapshot is written once.** `original_content is null` is both the "never edited" flag and
the write guard. A second edit must leave it alone; a plan edited twice still shows the model's
first output.

**Stale-tab edits must fail whole.** A payload naming a problem id that no longer exists (deleted
in another tab) hits the count-mismatch check and aborts the transaction — never a partial apply.
The owner sees the generic failure and a reload shows current state.

## Phase 1: Schema, edit RPC & grants

### Overview

One forward-only migration adds the edit surface to `action_plans`, the whole-plan edit RPC, and
the single new table grant. Regenerate types and push to the linked project.

### Changes Required:

#### 1. The migration

**File**: `supabase/migrations/<timestamp>_saved_plans_management.sql`

**Intent**: Open the FR-013/FR-014 write surface that `20260814132833_generate_action_plan.sql`
deliberately withheld, keeping its posture — structural writes are RPC-only, the four plan tables
stay `select`-only, `anon` gets nothing. Follow the house header style: state what is added, why,
and which lesson each choice answers.

**Contract**:

- `alter table public.action_plans add column updated_at timestamptz not null default now()` and
  `add column original_content jsonb`. `original_content` null means "never edited" — it is both
  the flag and the store, so no separate `edited_at` column exists.
- A bounds CHECK on the snapshot, mirroring the S-03 posture that a direct PostgREST call skips
  Zod: `check (original_content is null or jsonb_typeof(original_content) = 'object')`.
- `create trigger action_plans_touch_updated_at before update on public.action_plans for each row
  execute function public.touch_updated_at()` — reusing the generic function from
  `20260729171332_company_profile.sql:48`.
- `grant delete on public.action_plans to authenticated` plus
  `create policy "action_plans_delete_own" on public.action_plans for delete to authenticated
  using (company_id = (select public.current_company_id()))`. **No update grant on any plan
  table, no delete grant on any child table** — the cascade from `action_plans` handles children,
  and structural writes go through the RPC. Comment this absence explicitly, the way S-03 did.
- `create function public.update_action_plan(p_plan_id uuid, p_summary text, p_problems jsonb)
  returns void`, `language plpgsql`, `security definer`, `volatile`, `set search_path = ''`.
- `revoke all on function public.update_action_plan(uuid, text, jsonb) from public;` **and**
  `revoke all on function public.update_action_plan(uuid, text, jsonb) from anon;` then
  `grant execute … to authenticated`. The `anon` revoke is not belt-and-braces — see
  `20260814134807_harden_plan_rpc_grants.sql`, an entire migration written because that line was
  missing on `save_action_plan`.
- `comment on` the two new columns, the policy and the function.

#### 2. `update_action_plan()` body

**File**: same migration

**Intent**: Apply the owner's whole desired plan state in one transaction — rewrite text, drop
what they removed, keep numbering contiguous, and preserve the model's original on the first
edit — while re-deriving every tenancy guarantee inside Postgres rather than trusting the caller.

**Contract**: `p_problems` is a jsonb array whose element keys match the edit payload the Server
Action holds:

```
[{ "id": uuid, "title": text, "rationale": text,
   "actions": [{ "id": uuid, "content": text }] }]
```

Array order **is** the priority order — `rank` is assigned from position, never read from the
payload, exactly as `save_action_plan` does. Steps, in this order:

1. `v_company_id := public.current_company_id()`; null → raise `42501`. The company is resolved
   from the session and **never** from an argument.
2. Bound the payload: `jsonb_typeof(p_problems) = 'array'` and length between `1` and
   `PLAN_PROBLEMS_MAX` (8) → else `22023`. This is the ≥1-problem floor and the
   `20260814184500_bound_plan_problem_count.sql` bound in one statement, both ends named together
   so they cannot drift.
3. `select id into v_plan_id from public.action_plans where id = p_plan_id and company_id =
   v_company_id for update` — `not found` → raise `42501`. This is the tenancy check: the
   function bypasses RLS, so this predicate is the only thing scoping it. `for update` serializes
   concurrent edits of the same plan.
4. **Snapshot, before anything is written.** If `original_content is null`, build the pre-edit
   artifact from the stored rows — summary plus problems ordered by `rank`, each with `title`,
   `rationale` and its actions ordered by `position` — and write it. Shape:
   `{ "summary": text, "problems": [{ "title": …, "rationale": …, "actions": [text, …] }] }`.
5. **Verify every posted id belongs to this plan**, the same count-mismatch shape
   `save_action_plan` uses for citations: count distinct posted problem ids, compare against the
   number that actually resolve under `plan_id = p_plan_id`; mismatch → raise `23514`. Repeat per
   problem for its action ids under `problem_id`.
6. Per problem, enforce the ≥1-action floor and the `PROBLEM_ACTIONS_MAX` (5) ceiling → `22023`.
7. Delete `plan_problems` of this plan whose id is not in the payload (cascades to their actions
   and citations), then per surviving problem delete `plan_actions` not in its payload.
8. Update `title`/`rationale` on surviving problems and `content` on surviving actions from the
   payload.
9. Renumber with the offset pass described in Critical Implementation Details: `rank` 1..N from
   array order for problems, `position` 1..M per problem for actions.
10. `update public.action_plans set summary = p_summary where id = v_plan_id` — the touch trigger
    stamps `updated_at`.

Distinct SQLSTATEs are the point: `42501` for tenancy, `22023` for a violated floor or bound,
`23514` for an id that does not belong. The Server Action logs the code and shows one generic
message, but the contract suite asserts on each one specifically.

#### 3. Apply and regenerate

**File**: `src/lib/supabase/database.types.ts`

**Intent**: Get the two new columns and the new function into the generated types so a mistyped
column is a compile error rather than a runtime undefined. Regeneration after each migration is a
standing requirement noted at `src/lib/supabase/server.ts`.

**Contract**: `npx supabase db push`, then
`npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`. The file must
contain `original_content` and `updated_at` on `action_plans` and `update_action_plan` under
`Functions`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly from empty: `npx supabase db reset`
- Migration is applied **remotely**: `npx supabase db push` then `npx supabase migration list --linked`
  shows the new file with a non-empty remote column
- Regenerated `database.types.ts` contains `original_content`, `updated_at` and `update_action_plan`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Existing suites still pass: `npm run test:remote`

#### Manual Verification:

- Reading the migration top-to-bottom, the absence of an update grant and of any child-table
  delete grant is stated as a decision, not left to inference
- `psql`: calling `update_action_plan` with a plan id belonging to another company raises `42501`
  and changes nothing

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 2: DB contract tests

### Overview

The executable half of Phase 1. Prose in a migration cannot demonstrate that the floors hold, that
the renumber is gap-free, or that the snapshot is written once — and `lessons.md` records what
happens when a database-layer claim is ticked without being run.

### Changes Required:

#### 1. Editing contract suite

**File**: `tests/plan-editing.test.ts`

**Intent**: Prove every guarantee `update_action_plan` claims, against a real Postgres through an
anon-key client carrying a real owner JWT — the same caller shape a leaked key would give an
attacker.

**Contract**: Follows `tests/plans.test.ts` exactly: `requireLocalDb`, a service-role `admin`
client for fixtures, two independent owner fixtures for the cross-tenant cases, a **positive
control first**, and every denial asserted on its specific SQLSTATE — never on an empty array.
Cases:

- Positive control: an owner edits summary + a problem title + an action's content; the rows
  change and `updated_at` advances
- Cross-tenant: owner B calls `update_action_plan` with owner A's plan id → `42501`, and A's rows
  are byte-identical afterwards
- Foreign problem id in the payload → `23514`, nothing changed
- Foreign action id (belonging to a different problem of the same plan) → `23514`
- Removing the last problem → `22023`; removing the last action of a problem → `22023`
- Over the bounds: 9 problems → `22023`; 6 actions on one problem → `22023`
- Renumber: a plan of 4 problems with #2 removed leaves ranks `1,2,3` contiguous; same for
  `position` after removing a middle action
- Removal cascades: the removed problem's `plan_actions` and `plan_problem_submissions` rows are
  gone
- **Citations survive a text-only edit** — the grounding is not collateral damage of editing
- Snapshot: `original_content` is null before the first edit, holds the pre-edit summary and
  problem titles after it, and is **unchanged** after a second edit
- Write denials still hold: direct `update`/`delete` on `plan_problems`, `plan_actions`,
  `plan_problem_submissions` → `42501`; direct `update` on `action_plans` → `42501`
- Delete: an owner deletes their own plan and the children cascade; owner B's delete of owner A's
  plan matches zero rows and A's plan still exists
- `anon` (no JWT) calling `update_action_plan` → permission denied on the **function**, not the
  function's own raise (the `20260814134807` regression)

#### 2. Edit-payload unit tests

**File**: `tests/validation.test.ts` (extend) or `tests/plan-editing-schema.test.ts`

**Intent**: Exercise the Zod edit schema without a database or a token — the same reasoning
`plan-schema.ts` gives for staying pure.

**Contract**: `PlanEditSchema` rejects a missing/malformed problem id, a blank title after trim, an
over-long summary, zero problems, and zero actions on a problem; accepts a well-formed payload and
strips nothing the RPC needs.

### Success Criteria:

#### Automated Verification:

- New suite passes: `npm run test:remote`
- Full suite passes with no regressions: `npm run test:remote`
- Linting passes: `npm run lint`

#### Manual Verification:

- Each denial asserts a specific SQLSTATE; no test treats an empty array as evidence of a denial
- Temporarily removing the offset pass from the renumber makes the contiguity test fail with
  `23505` rather than passing silently

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Plans index + delete (FR-013 + FR-014a)

### Overview

`/dashboard/plans` stops being a generator page with one link at the bottom and becomes the plans
index: generate at the top, everything saved below. Deletion ships here because it belongs on the
list rows.

### Changes Required:

#### 1. List read, and retiring the placeholder

**File**: `src/lib/dal.ts`

**Intent**: Replace `getLatestActionPlan()` with the real list read FR-013 needs, keeping the
filter-free RLS-scoped convention every other read in this module follows.

**Contract**: Add `ACTION_PLAN_LIST_LIMIT = 50` with a doc comment giving the same reasoning
`SUBMISSION_LIST_LIMIT` gives — capped, not paginated — plus the note that generation is already
capped at 10/company/day so the list grows slowly. Add
`getActionPlans(): Promise<ActionPlanListRow[]>` selecting `id, created_at, updated_at,
original_content` with an embedded `plan_problems(count)` for the per-plan problem count, ordered
`created_at desc, id desc` to match `action_plans_company_created_idx`, limited to the constant.
Export `ActionPlanListRow` derived from the generated `Database` types, with `problemCount: number`
and `edited: boolean` (`original_content !== null`) computed in the mapping so no component
re-derives them. **Delete `getLatestActionPlan()`** and extend `getActionPlan`'s select with
`updated_at, original_content`, surfacing them on `ActionPlanDetail` (typed as the parsed original
or null).

#### 2. Delete action

**File**: `src/app/dashboard/plans/actions.ts`

**Intent**: Permanently remove one plan belonging to the caller's company (FR-014). Hard delete;
children cascade.

**Contract**: `deletePlan(_prevState: FormState<never>, formData: FormData)`, mirroring
`deleteSubmission` line for line: `verifySession()`, a `z.uuid()` guard on the id, `getCompany()`
for the seatbelt filter, `.delete().eq('id', …).eq('company_id', company.id).select('id')` — the
`.select('id')` is what makes a zero-row delete visible — and revalidation **before** returning on
the zero-row branch, so a stale row does not stay rendered under a permanent failure. Takes an
optional `redirectTo` hidden field so the detail page can redirect to `/dashboard/plans` while the
list page stays put; validate it against the literal `/dashboard/plans` rather than accepting an
arbitrary path.

#### 3. Messages

**File**: `src/app/dashboard/plans/messages.ts`

**Intent**: Add the outcome strings the new paths need, keeping the module's rule that generic
failures stay generic and specifics go to the log.

**Contract**: Add `PLAN_DELETED`, `PLAN_DELETE_FAILED`, `PLAN_UPDATE_FAILED`, and a
`PLAN_LIST_EMPTY` explanatory string. `PLAN_SAVED` is finally used in Phase 4 — update its doc
comment, which currently says it is unread.

#### 4. The index page

**File**: `src/app/dashboard/plans/page.tsx`

**Intent**: Show the generator and the saved plans on one route, so there is one place the owner
goes for anything about plans.

**Contract**: Fetch `getActionPlans()` alongside the existing three reads in the same
`Promise.all`. Keep every existing branch (no company / zero submissions / thin warning /
incomplete profile / `<PlanGenerator />`) unchanged, and **remove** the latest-plan link at the
foot. Below the generator, render a "Saved plans" section: `<PlanList>` when non-empty, otherwise
a short explanatory empty state. Dates are formatted **on the server** with the existing fixed
`en-GB` formatter and passed down as strings — the hydration reason `submission-list.tsx:10-17`
records. The zero-submission empty state and a non-empty list must be able to coexist: a saved
plan outlives the submissions it came from.

#### 5. List and row components

**File**: `src/app/dashboard/plans/plan-list.tsx`, `src/app/dashboard/plans/plan-row.tsx`

**Intent**: One row per saved plan, linking to it, with the two-step delete arm.

**Contract**: Structural copies of `submission-list.tsx` / `submission-row.tsx` — not a shared
abstraction, since the two differ in content and in the redirect behaviour. `PlanList` owns the
`role="status"` live region and the focus anchor, because those must outlive the row that a
successful delete unmounts; `handleDeleted` is `useCallback`-stable so the row's effect cannot
re-fire and steal focus. `PlanRow` owns its own `armed` state and moves focus to **Cancel** on
arming and back to **Delete** on disarm. Each row shows the formatted `created_at`, the problem
count, an "Edited" marker when `edited`, and links to `/dashboard/plans/<id>`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit` (this is what catches every remaining reference to the
  deleted `getLatestActionPlan`)
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Full suite passes: `npm run test:remote`

#### Manual Verification:

- With several saved plans, `/dashboard/plans` lists them newest first with correct problem counts
- Deleting from a list row removes it without a page navigation; the outcome is announced and
  focus lands outside the removed row
- Keyboard-only: Tab to Delete, Enter, focus lands on Cancel (not Confirm), Escape-equivalent
  Cancel returns focus to Delete
- An owner with zero submissions but one saved plan still sees the plan and the explanation, not a
  dead end
- Deleting the last plan leaves the empty state, not a blank region

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Edit mode + original view (FR-014b)

### Overview

The detail page gains an edit mode covering the whole plan in one form, backed by the Phase 1 RPC,
plus a read-only view of what the model originally wrote.

### Changes Required:

#### 1. Edit payload schema

**File**: `src/lib/plan-schema.ts`

**Intent**: Give the edit round trip the same treatment the save round trip has — reject a
malformed body cleanly, so a broken payload is one logged failure rather than a `22P02` surfacing
out of PostgREST as if it were user-facing.

**Contract**: `PlanEditSchema` reusing the existing bounds constants (`PLAN_SUMMARY_MAX`,
`PROBLEM_TITLE_MAX`, `PROBLEM_RATIONALE_MAX`, `ACTION_CONTENT_MAX`, `PLAN_PROBLEMS_MIN/MAX`,
`PROBLEM_ACTIONS_MIN/MAX`) and the `modelText` helper. Shape:
`{ summary, problems: [{ id: uuid, title, rationale, actions: [{ id: uuid, content }] }] }`.
`submissionIds` is deliberately **absent** — editing never touches citations, and accepting the
field even to ignore it would suggest otherwise. Export `PlanEdit` and, for the snapshot,
`PlanOriginalSchema` + `PlanOriginal` so the stored jsonb is parsed rather than trusted when
rendered. Document that the key names match `update_action_plan`'s jsonb argument exactly, the way
`VerifiedProblem` documents the same thing for `save_action_plan`.

#### 2. Update action

**File**: `src/app/dashboard/plans/actions.ts`

**Intent**: Persist an edited plan (FR-014) and stay on the page, unlike `savePlan` which
redirects.

**Contract**: `updatePlan(_prevState, formData)` reading a hidden `planId` and a hidden `plan` JSON
field, `JSON.parse` inside a try (an uncaught throw becomes the dashboard error boundary), then
`PlanEditSchema.safeParse`, then
`supabase.rpc('update_action_plan', { p_plan_id, p_summary, p_problems })`. On error, log
`error.code` and `error.message` and return `PLAN_UPDATE_FAILED` — never the RPC's own message,
which names which ids failed to resolve. On success, `revalidatePath('/dashboard/plans')` and
`revalidatePath('/dashboard/plans/' + planId)` (`revalidatePath` does not cascade to nested
routes) and return `{ message: PLAN_SAVED }`. Document that the round trip is not a trust boundary:
the RPC resolves the company from the session and re-verifies every id inside the transaction.

#### 3. Detail page + client shell

**File**: `src/app/dashboard/plans/[planId]/page.tsx`, `src/app/dashboard/plans/[planId]/plan-detail.tsx`

**Intent**: Keep the server page as the fetch + 404 boundary it already is, and move the
read/edit/original toggle into a client component that owns that state.

**Contract**: The page keeps its `z.uuid()` guard, `getActionPlan`, `notFound()`, and the no-oracle
comment — a foreign plan id and a nonexistent one must continue to render identically. It passes
the plan, the server-formatted `created_at`/`updated_at` strings, and the parsed original into
`<PlanDetail>`. `PlanDetail` renders one of three views: the read view (the existing markup,
moved), the editor, or the original. It shows "Edited on <date>" when the plan carries an original,
with a toggle to view it, and hosts the Edit button and the two-step delete arm (passing
`redirectTo=/dashboard/plans`). `lang="pl"` stays on generated content and off customer text — the
split the read page and the review screen both already make.

#### 4. The editor

**File**: `src/app/dashboard/plans/[planId]/plan-editor.tsx`

**Intent**: One controlled form over the whole plan, with removals staged locally so Cancel is a
genuine no-op on the database.

**Contract**: Holds `{ summary, problems }` in React state seeded from the plan. A textarea for the
summary; per problem an input for `title`, a textarea for `rationale`, and a textarea per action;
`maxLength` on each set from the shared bounds constants, so the browser cap and the server cap
cannot drift (the reason `SUBMISSION_CONTENT_MAX` is exported). **Remove** buttons on problems and
on actions mutate local state only, and are disabled — with a visible reason — when removing would
break a floor (last problem, or a problem's last action), so the RPC's `22023` is a backstop rather
than the owner's first feedback. Each problem keeps its citations rendered read-only underneath,
so the owner edits with the customer's words in front of them — the same argument
`plan-schema.ts:36-40` makes for the citation cap. Submit posts hidden `planId` and
`plan` (`JSON.stringify` of state) through `useActionState(updatePlan, undefined)`, disabling the
button while pending; Cancel returns to the read view and discards local state. Renders
`PLAN_SAVED` or `PLAN_UPDATE_FAILED` in an `aria-live="polite"` region.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Edit-schema unit tests pass: `npm run test`
- Full suite passes: `npm run test:remote`

#### Manual Verification:

- Editing the summary and one problem's title saves, stays on the page, and shows the confirmation
- Removing a middle problem leaves the remaining ranks numbered contiguously from 1
- Cancel after staging removals leaves the plan untouched on reload
- The Remove button is unavailable on the last problem and on a problem's last action, with the
  reason visible
- After the first edit, "Edited on <date>" appears and the original view shows the model's
  pre-edit wording; after a second edit the original view is unchanged
- Citations still render under each surviving problem after a text edit
- Editing a plan in one tab and deleting it in another produces a clean failure message, not a
  crashed page

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 5: Acceptance

### Overview

The end-to-end run on realistic data. Nothing here is automatable: it is the check on whether the
slice is *usable*, not whether it is wired.

### Changes Required:

#### 1. Acceptance walkthrough

**File**: no code — record the outcome in `context/changes/saved-plans-management/change.md`

**Intent**: Confirm FR-013 and FR-014 as the PRD states them, on a company with several saved
plans generated from real Polish submissions.

**Contract**: Generate two or three plans, then walk: index lists them → open one → edit wording →
remove a weak problem → save → confirm the original is still viewable → return to the index →
delete a plan → confirm it is gone from the index and its URL now 404s. Confirm cross-tenant
isolation by hand with a second account: a plan URL from account A returns 404 for account B.

### Success Criteria:

#### Automated Verification:

- Full suite green from a clean checkout: `npm run test:remote`
- `npx supabase migration list --linked` shows every migration applied remotely
- Production build succeeds: `npm run build`

#### Manual Verification:

- The full walkthrough completes without a dead end or an unexplained failure
- The edited plan reads as the owner's document while the original remains recoverable to read
- A second account cannot reach or modify the first account's plans through the UI or a pasted URL
- Deleting a plan does not affect submissions or other plans

---

## Testing Strategy

### Unit Tests:

- `PlanEditSchema`: malformed/missing ids, blank-after-trim fields, over-long fields, zero
  problems, zero actions on a problem, a well-formed payload
- `PlanOriginalSchema`: a valid snapshot parses; a malformed one is rejected rather than rendered

### Integration Tests:

- `tests/plan-editing.test.ts` against real Postgres via an anon-key client with a real owner JWT:
  positive control, cross-tenant refusal, foreign-id refusal, both floors, both ceilings, renumber
  contiguity, cascade on removal, citation survival, snapshot-once, standing write denials on the
  child tables, delete scoping, and `anon` denied EXECUTE on the new function

### Manual Testing Steps:

1. Save three plans; open `/dashboard/plans` and confirm order, counts and the empty-state absence
2. Delete a plan from a list row; confirm announcement, focus placement and that the others remain
3. Open a plan, edit the summary and a title, save, reload — changes persist, `updated_at` shown
4. Remove a middle problem; confirm remaining ranks are `1..N` with no gap
5. Stage removals, press Cancel, reload — nothing changed
6. Edit a second time; confirm the original view still shows the model's *first* output
7. Two tabs: delete in one, save in the other — clean failure, no crashed page
8. Second account: paste a plan URL from the first account — 404, identical to a nonexistent id

## Performance Considerations

The list read is one round trip with an embedded count, capped at 50 rows, served by
`action_plans_company_created_idx` whose leading column matches the RLS predicate. The edit RPC
touches at most 8 problems × 5 actions inside one transaction with `for update` on the plan header
— the renumber's two passes are two small UPDATEs, not a per-row loop. No model call and no spend
is involved in any path this slice adds, so the generation cap and its ledger are untouched.

## Migration Notes

Forward-only, like every migration in this repo — the new file compensates and extends
`20260814132833_generate_action_plan.sql` rather than editing it. Existing saved plans get
`updated_at = now()` from the column default (they read as "not edited" because `original_content`
stays null, which is correct — they have not been). `db push` must be followed by
`supabase migration list --linked` as evidence, per `lessons.md`: a migration in the repo is not a
migration in the database.

## References

- Slice definition: `context/foundation/roadmap.md` (S-04)
- Upstream slice: `context/changes/generate-action-plan/plan.md`, `plan-brief.md`
- Standing rules: `context/foundation/lessons.md`
- Schema this extends: `supabase/migrations/20260814132833_generate_action_plan.sql`
- Function-grant trap: `supabase/migrations/20260814134807_harden_plan_rpc_grants.sql`
- Narrow-grant precedent: `supabase/migrations/20260730190000_narrow_company_write_grants.sql`
- Delete UX pattern: `src/app/dashboard/submissions/submission-row.tsx:22-142`
- Contract-suite style: `tests/plans.test.ts:1-80`
- Reads to extend/retire: `src/lib/dal.ts:171` (`getActionPlan`), `src/lib/dal.ts:240`
  (`getLatestActionPlan`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema, edit RPC & grants

#### Automated

- [ ] 1.1 Migration applies cleanly from empty: `npx supabase db reset` — BLOCKED, no container runtime on this machine (same as `submission-intake` 1.2 and `generate-action-plan` 1.1); `lessons.md` forbids ticking by inference. Compensating control: 1.2 plus the Phase 2 contract suite
- [x] 1.2 Migration applied remotely: `npx supabase db push` + `npx supabase migration list --linked` shows a non-empty remote column — 3300149
- [x] 1.3 Regenerated `database.types.ts` contains `original_content`, `updated_at` and `update_action_plan` — 3300149
- [x] 1.4 Type checking passes: `npx tsc --noEmit` — 3300149
- [x] 1.5 Linting passes: `npm run lint` — 3300149
- [x] 1.6 Existing suites still pass: `npm run test:remote` — 3300149

#### Manual

- [x] 1.7 The absence of an update grant and of any child-table delete grant is stated as a decision in the migration — 3300149
- [x] 1.8 `update_action_plan` with another company's plan id raises `42501` and changes nothing — verified against the **linked remote** project (no container runtime for `psql`, same constraint as 1.1), with two throwaway owner fixtures driven through an anon-key client carrying a real owner JWT. Owner B posted owner A's real problem/action ids with every string rewritten, one action dropped and one problem removed; got `42501 update_action_plan: plan <id> is not accessible to company <B>`, and A's header, problems, actions and citations came back byte-for-byte identical, `original_content` still `null` and `updated_at` unmoved — so the snapshot and the touch trigger did not fire either. A plan id that never existed raised the identical error (no oracle), and the positive control — owner A applying that same payload — succeeded, renumbered to `rank`/`position` 1 and wrote the snapshot. Fixture users deleted afterwards. Re-run as code in Phase 2's `tests/plan-editing.test.ts` — 3300149

### Phase 2: DB contract tests

#### Automated

- [x] 2.1 New editing suite passes: `npm run test:remote`
- [x] 2.2 Full suite passes with no regressions: `npm run test:remote`
- [x] 2.3 Linting passes: `npm run lint`

#### Manual

- [x] 2.4 Each denial asserts a specific SQLSTATE; no test treats an empty array as evidence of a denial — reviewed against the full assertion inventory of `tests/plan-editing.test.ts`: 15 SQLSTATE assertions (`42501` tenancy at 437/479/480/513 and the standing table-privilege denials at 1005/1018/1035; `23514` foreign-id at 562/603; `22023` malformed-id-set and floor/ceiling at 624/645/680/710/738/758). Two assertions DO accept an empty array, at 1111 and 1138, and both are deliberate: a cross-tenant `delete` is refused by RLS rather than by a grant, so PostgREST reports success-with-zero-rows and there is no error code to assert. Each is paired with a service-role read proving the row survived (1112, 1140-1141), which is what keeps them from being the failure mode this item exists to catch. The `toHaveLength(0)` assertions at 885-887 and 1074-1076 are cascade checks on a SUCCESSFUL operation, not denials
- [ ] 2.5 Removing the offset pass from the renumber makes the contiguity test fail with `23505` — WAIVED by the owner after review; not blocked in the sense 1.1 is, but consciously not run. Two reasons on the record. First, the same missing container runtime: with no Docker and no Postgres connection string in `.env.local` (REST keys only, no `psql`), the only DDL channel to a live database is `supabase db push` at the linked project, which would mean shipping a deliberately broken function and a second migration undoing it into forward-only history. Second, and the reason it was waived rather than deferred: the experiment is NON-DETERMINISTIC. Without the offset, whether the set-based `UPDATE` collides depends on the order Postgres happens to scan rows in, so it may raise `23505` or may silently produce the right answer on a given run — which is exactly why the offset is there, and also why "remove it and watch it fail" is not a reliable check. Compensating control: the two renumbering tests assert exact contiguity (`[1,2,3]` for `rank`, `[1,2]` for `position`) PLUS the surviving titles and contents in order, so a renumber that half-worked fails them on the values rather than on an error code

### Phase 3: Plans index + delete (FR-013 + FR-014a)

#### Automated

- [x] 3.1 Type checking passes: `npx tsc --noEmit` — b68a9af
- [x] 3.2 Linting passes: `npm run lint` — b68a9af
- [x] 3.3 Build succeeds: `npm run build` — b68a9af
- [x] 3.4 Full suite passes: `npm run test:remote` — b68a9af

#### Manual

- [x] 3.5 `/dashboard/plans` lists saved plans newest first with correct problem counts — b68a9af
- [x] 3.6 Deleting from a list row announces the outcome and places focus outside the removed row — b68a9af
- [x] 3.7 Keyboard-only arm/cancel moves focus to Cancel then back to Delete — b68a9af
- [x] 3.8 An owner with zero submissions but one saved plan still reaches the plan — b68a9af
- [x] 3.9 Deleting the last plan leaves the empty state, not a blank region — b68a9af

### Phase 4: Edit mode + original view (FR-014b)

#### Automated

- [x] 4.1 Type checking passes: `npx tsc --noEmit`
- [x] 4.2 Linting passes: `npm run lint`
- [x] 4.3 Build succeeds: `npm run build` — failed first with `next/headers` reaching the browser bundle: the editor is a CLIENT component and imports plan-schema.ts's bounds, and plan-schema.ts had a VALUE import of `SUBMISSION_LIST_LIMIT` from the `server-only` dal.ts. Fixed by moving both list caps to a pure `src/lib/list-limits.ts`; dal.ts, plan-schema.ts and the two pages now import from there
- [x] 4.4 Edit-schema unit tests pass: `npm run test` — the pure suites pass (104 tests, incl. 63 across `plan-editing-schema` + `validation`). The four DB suites refuse to run under bare `npm run test` by design (`requireLocalDb`, no local Postgres on this machine); they pass under 4.5
- [x] 4.5 Full suite passes: `npm run test:remote` — 9 files, 200 tests

#### Manual

- [x] 4.6 Editing summary and a problem title saves in place with a confirmation
- [x] 4.7 Removing a middle problem leaves ranks contiguous from 1
- [x] 4.8 Cancel after staging removals leaves the plan untouched on reload
- [x] 4.9 Remove is unavailable on the last problem and the last action, with a visible reason
- [x] 4.10 The original view shows the model's pre-edit wording and is unchanged after a second edit
- [x] 4.11 Citations still render under each surviving problem after a text edit
- [x] 4.12 Editing a plan deleted in another tab fails cleanly

### Phase 5: Acceptance

#### Automated

- [ ] 5.1 Full suite green from a clean checkout: `npm run test:remote`
- [ ] 5.2 `npx supabase migration list --linked` shows every migration applied remotely
- [ ] 5.3 Production build succeeds: `npm run build`

#### Manual

- [ ] 5.4 The full walkthrough completes without a dead end or an unexplained failure
- [ ] 5.5 The edited plan reads as the owner's document while the original remains viewable
- [ ] 5.6 A second account cannot reach or modify the first account's plans
- [ ] 5.7 Deleting a plan does not affect submissions or other plans
