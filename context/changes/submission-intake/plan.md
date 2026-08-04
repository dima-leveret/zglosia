# Submission Intake — Manual Add, List, Delete — Implementation Plan

## Overview

Roadmap slice **S-02**. The owner can manually add a submission, browse their company's submissions, and delete one (FR-007, FR-008, FR-009). This is the store the north-star slice (S-03) reads from: without it there is nothing to generate a plan out of.

It is also the first table in the product to key its RLS on `public.current_company_id()` — the helper F-01 built and documented for exactly this purpose but never had a consumer for. The isolation contract established here is the one S-03, S-04, and S-06 inherit.

## Current State Analysis

The tenant foundation is complete and the conventions around it are settled; nothing about submissions exists yet.

- `public.companies` is the only table. It holds one row per auth user, auto-provisioned by the `on_auth_user_created` trigger, with RLS keyed directly on `auth.uid()`.
- `public.current_company_id()` (`supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:61-75`) is `security definer`, `stable`, `set search_path = ''`, granted to `authenticated`, and its own comment names it "the reusable predicate for downstream tenant-table RLS policies". **No table uses it yet.**
- Write privileges on `companies` were deliberately narrowed to `update (name, industry, description, location)` — `insert` and `delete` are revoked from `authenticated` outright (`supabase/migrations/20260730190000_narrow_company_write_grants.sql`). So this slice is the first place `insert` and `delete` are legitimately granted to an owner, and none of the existing test coverage exercises either verb.
- The read/write split in the DAL is a deliberate asymmetry, documented in place: reads rely on RLS alone with no owner filter (`src/lib/dal.ts:27-50`), writes add an explicit filter **and** a `.select('id')` so a zero-row write is distinguishable from a successful one (`src/app/dashboard/company/actions.ts:41-71`). The second half exists because PostgREST returns `{ data: null, error: null }` for an UPDATE matching nothing — review finding F2.
- Server Actions are POSTs to their own route, so `src/proxy.ts` does not guard them. `verifySession()` at the top of every action is the boundary, not the proxy.
- Both Supabase clients are parameterised with the generated `Database` type (`src/lib/supabase/server.ts:27,55`), so a typo'd column is a build error. Types must be regenerated after the migration or every `submissions` query degrades to `any`.
- Vitest is wired (`npm test`), with three suites and a two-owner fixture in `tests/isolation.test.ts` that provisions real auth users through the service-role client. The DB-touching suites refuse to run against a non-local host unless `ALLOW_REMOTE_TEST_DB=1` — `npm run test:remote` is that opt-in (finding F1). `AGENTS.md` still says "No test runner is configured yet"; that line is stale.

### Key Discoveries:

- `current_company_id()` already exists, is granted, and is proven by `tests/isolation.test.ts:153-164` — this slice needs no new isolation primitive, only its first correct use.
- `lessons.md` records three rules that all bear on Phase 1: grants ship in the same migration as the `create table`; the grant must name the narrowest verb *and* the narrowest column set; and a migration in the repo is not a migration in the database — only `supabase migration list --linked` closes it.
- Cross-tenant denial on a write is **silent** (`tests/isolation.test.ts:167-182`): zero rows matched, no error. Any test asserting only on `error` passes with the policies dropped. Denials must be proven by re-reading the row through the service-role client.
- `validation.ts:33-46` already has the `requiredText(label, max)` helper and states its caps are an S-03 prompt-token budget — the submission cap belongs in the same vocabulary, not as a loose literal.
- `companies` carries no `updated_at` problem to inherit: `touch_updated_at()` is written generically (`supabase/migrations/20260729171332_company_profile.sql:48-60`) and is available if a future slice needs it. `submissions` does not — see below.

## Desired End State

An owner opens `/dashboard/submissions`, types a customer complaint into the add form, and saves it. It appears at the top of the list marked as manually entered, with its entry date. The dashboard shows how many submissions they have and links here. Clicking Delete on a row swaps that row's control to a confirm/cancel pair; confirming removes the submission permanently. Owner B can neither read, insert into, nor delete from owner A's submissions, and no owner — through the UI or through a raw anon-key PostgREST call — can create a submission claiming to be a customer's form entry.

Verified by: `npm run test:remote` passing all suites including the new cross-tenant and source-forgery cases, plus the manual walkthrough in each phase.

### Key Decisions (all confirmed during planning):

| Area | Decision |
| --- | --- |
| Source discriminator | Postgres enum `public.submission_source` (`'manual'`, `'form'`), `not null`. Generates as a `'manual' \| 'form'` union in `database.types.ts` rather than bare `string`. |
| Field set | `content` only, plus `id`, `company_id`, `source`, `created_at`. No author field, no occurred-on date, no owner category. |
| Content cap | 2000 chars, mirroring the existing `DESCRIPTION_MAX` in `src/lib/validation.ts:35`. |
| Delete semantics | Hard delete. No `deleted_at`, no filtered reads, no undo. |
| Source integrity | The `authenticated` insert policy pins `source = 'manual'` in its `with check`. S-06 adds its own `anon` policy pinning `'form'`; **nothing for `anon` ships in this slice.** |
| Citation grounding | uuid PK, no ordinal column. S-03 numbers submissions at prompt time and resolves citations back to uuids before saving a plan — a constraint that slice's plan must carry. |
| Listing | Newest-first, capped at 100, with an exact total count and an explicit "showing the latest 100 of N" notice. Backed by a `(company_id, created_at desc)` index. |
| Surface | One page, `/dashboard/submissions` — server component + client add form, mirroring `/dashboard/company`. Inherits the existing `/dashboard` prefix guard in `src/proxy.ts:7`. |
| Delete confirmation | Inline two-step: the row's Delete button swaps to Confirm + Cancel. Not `confirm()`, not type-to-confirm. |
| Dashboard wiring | Submission count + link. Empty state lives on the list page. |
| No UPDATE, anywhere | FR-010 (edit a submission) is parked in the roadmap and PRD. So: no update policy, no update grant, no `updated_at` column, no trigger. Editing a customer's words is the thing the PRD says not to do. |
| `company_id` provenance | Always read server-side via `getCompany()` on the RLS-scoped session client. Never from `FormData`, a query param, or a hidden input. |
| Testing | Full: schema/grant assertions, cross-tenant select/insert/delete denial, positive control, source-forgery denial, and Zod unit tests. |

## What We're NOT Doing

- **Editing a submission** (FR-010) — parked in the roadmap and explicitly nice-to-have-only in the PRD. No update path at any layer.
- **The public form or anything `anon`-facing** (S-05, S-06) — no `anon` grant, no `anon` policy, no public route. The insert policy is *shaped* so S-06 slots in cleanly; it is not opened here.
- **Plan generation** (S-03) — no LLM call, no prompt, no "Generate plan" button. The count on the dashboard is where that button will later attach, nothing more.
- **Pagination beyond the capped page** — no offset links, no load-more, no cursor.
- **Soft delete, undo, trash, or an audit trail.**
- **Search, filtering, or sorting controls** on the list.
- **Retention policy, PII redaction, or data export** — RODO surface was explicitly ruled out of this slice's scope.
- **Spam / rate-limit defences** — that NFR belongs to S-06, where an unauthenticated path actually exists.
- **Bulk actions** (select-many, delete-all).
- **Reworking `/dashboard` into a real shell** — one count and one link, as with the company-profile link before it.

## Implementation Approach

One additive migration creates the enum, the table, its policies, its grants, and its index together — the whole object arrives in a working state, per `lessons.md`. Every owner-facing read and write goes through the RLS-scoped session client from `createClient()`; the service-role client appears nowhere in this slice, not even in the delete path. Postgres does the tenant scoping through `company_id = public.current_company_id()`, and the application adds an explicit `company_id` filter on writes as the seatbelt the codebase already established.

The `source` invariant is enforced in Postgres rather than in application code. An owner's session can only ever produce `source = 'manual'` rows, because the insert policy's `with check` says so — a raw PostgREST call with the anon key cannot forge a customer submission. This is what makes FR-008's "oznaczenie źródła" a guarantee rather than a convention.

## Critical Implementation Details

**Revoke before granting.** The migration must `revoke all ... from anon, authenticated` immediately after `create table`, before any grant. `lessons.md` records that the linked project predates the current Supabase default and therefore auto-exposes new tables: `create table` there triggers default privileges granting ALL to `anon`, `authenticated`, and `service_role`. An additive-only grant block would then add nothing, and the three privilege decisions this slice rests on — column-scoped insert, no update anywhere, nothing for `anon` — would hold on a fresh `db reset` but not on the database the app actually runs against. The revoke is what makes the two environments agree.

**Column-scoped insert grant.** `grant insert` must name `(company_id, content, source)` and no more. A table-wide insert grant would let an owner set `id` and `created_at` on their own rows — the same class of hole review finding F3 found on `companies`, where a self-chosen `id` was load-bearing because S-06 keys the public URL on it. RLS cannot express column scope; only the grant can.

**Wrap the helper in a subselect.** `(select public.current_company_id())`, never the bare call — the InitPlan form the F-01 policies established for `auth.uid()`. Every downstream tenant table inherits whichever shape ships here.

**A zero-row write is a silent success.** Both the insert and the delete must end in `.select('id')` and check the returned array is non-empty. Without it, a delete that matched nothing (wrong id, another tenant's row) is indistinguishable from a successful one and the owner is told it worked.

**The migration is not done when it is committed.** Phase 1 closes only when `npx supabase migration list --linked` shows the new migration with a populated remote column. `lessons.md` records a full day where two hardening migrations sat in the repo while the bug they fixed was live.

## Phase 1: Schema Migration (enum, table, RLS, grants, index)

### Overview

Create `public.submissions` and everything it needs to be usable in one migration: the source enum, the table, three policies, the grants, and the list index. Then push it and prove it landed.

### Changes Required:

#### 1. Migration file

**File**: `supabase/migrations/<timestamp>_submission_intake.sql` (create with `npx supabase migration new submission_intake`)

**Intent**: Add the submissions store as the first tenant table keyed on `current_company_id()`, with the privilege surface an owner actually exercises and nothing more. Comment the file in the style of the two existing migrations — they explain *why* each choice was made, and that is what made the F3 review possible.

**Contract**: One enum type, one table, RLS enabled, three policies, two grant statements, one index. No `update` policy and no `update` grant anywhere — FR-010 is parked. No `updated_at` column and no trigger, for the same reason. Nothing granted to `anon`.

The policy and grant set is the load-bearing part of this slice and is reproduced in full, because the `source` pin and the column scope are both easy to lose in translation:

```sql
create type public.submission_source as enum ('manual', 'form');

create table public.submissions (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  content    text not null,
  source     public.submission_source not null,
  created_at timestamptz not null default now()
);

alter table public.submissions enable row level security;

-- Load-bearing, and easy to mistake for redundancy: the linked project
-- predates the current Supabase default and DOES auto-expose new tables,
-- so `create table` above may already have granted ALL to anon and
-- authenticated via default privileges — before a single grant below runs.
-- Without this revoke, the column-scoped insert, the deliberate absence of
-- any update privilege, and "nothing for anon" are all silently void on
-- that database while looking correct in the repo. Revoking first makes the
-- grant block the authoritative privilege set in EVERY environment.
-- Do not delete this as a no-op.
revoke all on public.submissions from anon, authenticated;

-- Every predicate wraps the helper in a subselect, exactly as the F-01
-- policies wrap auth.uid(). That forces an InitPlan so the function is
-- evaluated once per statement instead of once per row — this is the one
-- table in the product designed to grow unbounded, and every downstream
-- tenant table copies this policy shape.
create policy "submissions_select_own"
  on public.submissions for select
  to authenticated
  using (company_id = (select public.current_company_id()));

-- The `source` pin is what makes FR-008's origin marking a database
-- guarantee: an owner's session cannot mint a row claiming to be a
-- customer's form submission. S-06 adds the symmetric `anon` policy
-- pinning 'form'; nothing for `anon` ships here.
create policy "submissions_insert_own_manual"
  on public.submissions for insert
  to authenticated
  with check (
    company_id = (select public.current_company_id())
    and source = 'manual'
  );

create policy "submissions_delete_own"
  on public.submissions for delete
  to authenticated
  using (company_id = (select public.current_company_id()));

-- Narrowest verb AND narrowest column set (lessons.md). A table-wide
-- insert grant would let an owner choose their own `id` and `created_at`.
grant select, delete on public.submissions to authenticated;
grant insert (company_id, content, source) on public.submissions to authenticated;

-- `id desc` is a tiebreaker, not decoration: rows inserted in the same
-- statement share created_at, and without it the list order — and the
-- fixtures Phase 5 seeds — are non-deterministic.
create index submissions_company_created_idx
  on public.submissions (company_id, created_at desc, id desc);
```

**Intent (cascade)**: `on delete cascade` on `company_id` is required, not incidental — account deletion works by deleting the `auth.users` row, which cascades to `companies`; without the cascade here that delete fails on the FK and erasure breaks. It also means the blast radius of `deleteAccount` now includes submissions, which the S-01 brief flagged as something to revisit. It is correct under the RODO NFR, and worth a comment in the migration.

#### 2. Committed schema assertions

**File**: `tests/schema.test.ts`

**Intent**: Prove the migration landed on the target database, behaviourally rather than by introspection — the existing suite's documented approach (`tests/schema.test.ts:8-19`), since PostgREST exposes only the `public` schema.

**Contract**: Extend the existing suite with a `submissions` describe block asserting: an authenticated owner can insert `{ company_id, content, source: 'manual' }` and read it back; the enum rejects a value outside `('manual','form')`; an insert supplying an explicit `id` or `created_at` is refused (`42501`, proving the column-scoped grant); an `update` attempt is refused (proving no update grant exists); and a bare anon-key client with no session is refused on both select and insert (proving the revoke held and nothing leaked to `anon` ahead of S-06). Reuse the file's existing `beforeAll` owner fixture rather than adding a second one.

These four negative assertions are the automated proof that the revoke-then-grant block did its job. Without them the privilege surface is verifiable only by eye in Studio, which is how the same class of gap survived twice before.

### Success Criteria:

#### Automated Verification:

- Migration is applied remotely: `npx supabase migration list --linked` shows the new file with a populated remote column
- **Blocked, not waived** — replay from empty (`npx supabase db reset`) cannot run: no container runtime on this machine (S-01 review finding F1). Record it as blocked; `lessons.md` forbids ticking it by inference, and the privilege assertions above are the compensating control
- Schema assertions pass: `npm run test:remote`
- Type regeneration produces the new table: `npx supabase gen types typescript --linked` includes `submissions` and `submission_source`
- Linting passes: `npm run lint`

#### Manual Verification:

- In Supabase Studio, `submissions` shows RLS enabled with exactly three policies and no update policy
- The `authenticated` role's privileges on `submissions` show `select`, `delete`, and a column-scoped `insert` — no `update`
- The `anon` role has no privileges on `submissions` at all
- Deleting a test auth user removes that user's submissions along with their company row

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Validation + Data Access Contract

### Overview

Give the application a typed, RLS-scoped way to read submissions and a validated way to describe one, with no UI attached yet.

### Changes Required:

#### 1. Regenerated database types

**File**: `src/lib/supabase/database.types.ts`

**Intent**: Without this, every `.from('submissions')` call is `any` and the enum union is lost — the gap review finding F9 raised.

**Contract**: Regenerate via the command in `src/lib/supabase/server.ts:11-12`. `Database['public']['Tables']['submissions']` and `Database['public']['Enums']['submission_source']` must both be present, and `Enums` must no longer be `[_ in never]: never`.

#### 2. Submission schema

**File**: `src/lib/validation.ts`

**Intent**: Validate the one field the owner types. `source` is deliberately absent from the schema — it is set server-side, never accepted from the form.

**Contract**: Add `SUBMISSION_CONTENT_MAX = 2000` alongside the existing caps (with the same "S-03 prompt-token budget" framing), a `SubmissionSchema` built from the existing `requiredText` helper, a `SubmissionInput` inferred type, and a `SubmissionField` union for `FormState<SubmissionField>`.

#### 3. Submission reads

**File**: `src/lib/dal.ts`

**Intent**: Two reads — the capped list for the submissions page, and a bare count for the dashboard. Both follow the file's read convention: `verifySession()` first, no explicit company filter, RLS does the scoping.

**Contract**: `getSubmissions()` returns the newest 100 rows plus the exact total, so the page can render "showing the latest 100 of N" without a second query — one `.select('id, content, source, created_at', { count: 'exact' })` with `.order('created_at', { ascending: false })`, a secondary `.order('id', { ascending: false })` tiebreaker matching the index, and `.limit(100)`. `getSubmissionCount()` returns just the total via a `head: true` count query. Both wrapped in `cache()` like the existing `getCompany`. Export the row type the list component consumes so the component does not re-declare it.

#### 4. Schema unit tests

**File**: `tests/validation.test.ts`

**Intent**: Pin the validation contract without touching a database, so these run under plain `npm test`.

**Contract**: Extend the existing suite: content is required, whitespace-only fails as required (not as too-short), trimming happens before the length check, exactly 2000 chars passes, 2001 fails with the cap message.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Unit tests pass: `npm test`
- Linting passes: `npm run lint`
- `getSubmissions()` returns a typed row where `source` is `'manual' | 'form'`, not `string`

#### Manual Verification:

- Calling `getSubmissions()` from a scratch server component returns only the caller's rows when two owners have data

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Add + List Surface

### Overview

The owner-facing page: add a submission, see the list, reach it from the dashboard. Delete comes in Phase 4, so this phase is independently shippable as FR-007 + FR-008.

### Changes Required:

#### 1. Submissions page

**File**: `src/app/dashboard/submissions/page.tsx`

**Intent**: Server component that reads through the DAL and composes the add form above the list. Mirrors `src/app/dashboard/company/page.tsx` in structure, heading, and back-link.

**Contract**: Renders the add form, then either the list or an empty state explaining that submissions are what action plans are generated from. When the total exceeds the cap, renders an explicit "showing the latest 100 of N" line rather than silently truncating.

#### 2. Add form

**File**: `src/app/dashboard/submissions/submission-form.tsx`

**Intent**: Client component wrapping `useActionState`, following `company-profile-form.tsx` exactly — including the two accessibility rules that file documents: no HTML `required` (it would short-circuit the server's field-specific messages), and `role="alert"` + `aria-describedby` on every field error.

**Contract**: One textarea named `content` with `maxLength={2000}`, a pending-disabled submit button, and an `aria-live="polite"` status line for `state.message`.

**Clearing and preserving are one mechanism, not two.** React 19 resets an uncontrolled form after a form action completes and does not distinguish success from a validation failure — so the naive build either clears on both (the owner loses up to 2000 typed characters to a trailing-whitespace rejection) or on neither (and the form never clears). `company-profile-form.tsx` never exposes this because every field re-fills from a `defaultValue` prop; this form has no row to re-fill from.

Resolve it by echoing the submitted content back: `FormState` carries the rejected value alongside `errors`, and the textarea's `defaultValue` reads from it — empty on success (so the reset sticks and the form is clear for the next complaint), the owner's text on failure (so nothing is lost). Verify the reset behaviour empirically in this fork rather than assuming it; `AGENTS.md` warns this Next build has breaking changes vs. stock, so check `node_modules/next/dist/docs` and the actual rendered behaviour before finalising.

#### 3. Submission list

**File**: `src/app/dashboard/submissions/submission-list.tsx`

**Intent**: Presentational list of rows: content, entry date, and a source badge distinguishing a manual entry from a customer's form submission. The badge is the visible half of FR-008 — the owner needs to know whose voice they are reading before they act on it.

**Contract**: Takes the typed rows from the DAL. Server component in this phase; Phase 4 introduces a client row component for the delete control. Long content wraps rather than truncating — with the cap at 2000 chars, the full text is short enough to read in place.

#### 4. Create action

**File**: `src/app/dashboard/submissions/actions.ts`

**Intent**: Validate and insert one manual submission.

**Contract**: `createSubmission(prevState, formData): Promise<FormState<SubmissionField>>`. Order: `verifySession()`, parse with `SubmissionSchema`, resolve `company_id` from `getCompany()`, insert `{ company_id, content, source: 'manual' }` on the session client with `.select('id')`, treat an empty result as failure, then `revalidatePath` both `/dashboard/submissions` and `/dashboard`.

`getCompany()` is typed to return `null` — both existing pages render a "No company is provisioned" branch for it. Return the generic failure message and attempt no write in that case; dereferencing it would throw into `src/app/dashboard/error.tsx` for a state the rest of the app handles gracefully.

**SECURITY**: `company_id` comes from `getCompany()` and from nothing else — never `FormData`, never a hidden input. The RLS `with check` would reject a forged id anyway, but the application must not be the layer that tries. Same invariant `deleteAccount` documents at `src/app/dashboard/company/actions.ts:87-95`.

#### 5. Dashboard wiring

**File**: `src/app/dashboard/page.tsx`

**Intent**: Show the submission count and link to the page, so the owner can judge from the dashboard whether they have enough collected to be worth acting on.

**Contract**: Add a count read via `getSubmissionCount()` and a link styled as a secondary action alongside the existing company-profile link. Wording should read naturally at zero.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Existing suites still pass: `npm run test:remote`

#### Manual Verification:

- Adding a submission shows it at the top of the list with a "manual" badge and today's date
- The form clears after a successful add; adding a second submission works without a reload
- Submitting empty or whitespace-only content shows an inline field error and saves nothing
- A rejected submission keeps the owner's typed content in the textarea — type ~500 chars with a trailing-space-only variant that fails validation and confirm nothing is lost
- Content at exactly 2000 chars saves; the textarea stops accepting more
- A brand-new account sees the empty state, not an empty list
- The dashboard count matches the number of rows on the page and updates after an add
- Visiting `/dashboard/submissions` while logged out redirects to `/login`

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Delete Path

### Overview

Hard-delete a single submission behind an inline two-step confirmation.

### Changes Required:

#### 1. Row delete control

**File**: `src/app/dashboard/submissions/submission-row.tsx` (new) and `submission-list.tsx` (compose it)

**Intent**: A client component per row holding the one piece of state this slice needs: whether that row is armed for deletion. Delete swaps to Confirm + Cancel, scoped to the row so arming one never arms another.

**Contract**: Confirm submits a form carrying the submission id to `deleteSubmission`. The confirm button is disabled while pending. Cancel returns the row to its resting state. The armed state must be announced — a screen-reader user needs to know the button they are about to press is now destructive.

#### 2. Delete action

**File**: `src/app/dashboard/submissions/actions.ts`

**Intent**: Remove one submission belonging to the caller's company.

**Contract**: `deleteSubmission(prevState, formData): Promise<FormState<'submission'>>`. Order: `verifySession()`, validate the id is a uuid with Zod (an unparseable id otherwise reaches PostgREST as a `22P02` error rather than a clean rejection), resolve `company_id` from `getCompany()` — returning the generic failure message if it is null, as `createSubmission` does — then `.delete().eq('id', id).eq('company_id', companyId).select('id')`, treat an empty result as failure with a generic message, then `revalidatePath` both routes.

The `company_id` filter is the same seatbelt the update path documents: RLS is the boundary, but a delete that over-matches destroys rows rather than merely leaking them. The generic failure message is deliberate — telling the owner "that submission isn't yours" confirms the row exists.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Clicking Delete arms only that row; other rows keep their normal button
- Cancel disarms the row and deletes nothing
- Confirm removes the row from the list and decrements the dashboard count
- A deleted submission stays gone after a hard reload
- Keyboard-only: the row can be armed, confirmed, and cancelled without a mouse

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 5: Isolation & Forgery Verification

### Overview

Prove in code that the isolation contract holds on the first table to use `current_company_id()`, and that the `source` pin cannot be circumvented. This is the phase that makes the FR-001 guardrail true for submissions rather than assumed.

### Changes Required:

#### 1. Cross-tenant assertions

**File**: `tests/isolation.test.ts`

**Intent**: Extend the existing two-owner harness to `submissions`. The fixture in this file already provisions two owners and their company ids; reuse it rather than building a second one.

**Contract**: A new describe block seeding a submission for owner A through the service-role client, then asserting from owner B's anon-key session:

- an unfiltered `select` on `submissions` returns only B's own rows
- a targeted `select` on A's submission id returns `[]`
- an `insert` naming A's `company_id` is refused
- a `delete` of A's submission id reports success with zero rows matched, **and A's row is still present when re-read through the service-role client** — the re-read is the assertion that matters; the error check alone would pass with the policies dropped
- positive control: owner A can insert, list, and delete their own submission (without it, every denial above would also pass on a table nobody can write to)

#### 2. Source-forgery assertion

**File**: `tests/isolation.test.ts`

**Intent**: Pin the FR-008 integrity guarantee. This is the case with no equivalent anywhere in the existing suites.

**Contract**: Owner A, on their own `company_id`, attempts an insert with `source: 'form'` and is refused by the `with check`. The companion assertion is that the same insert with `source: 'manual'` succeeds — otherwise a broken grant would produce a passing test for the wrong reason.

### Success Criteria:

#### Automated Verification:

- All suites pass: `npm run test:remote`
- The new cases fail as expected when temporarily pointed at a dropped policy (spot-check that the tests can fail — a denial test that cannot fail proves nothing)
- Linting passes: `npm run lint`

#### Manual Verification:

- Two browser sessions signed in as different owners show disjoint submission lists
- With owner B's session, a direct PostgREST call against owner A's submission id returns nothing

**Implementation Note**: This is the final phase. Confirm the full walkthrough before marking the change implemented.

---

## Testing Strategy

### Unit Tests:

- `SubmissionSchema`: required, whitespace-only, trim-before-length, boundary at 2000/2001 chars
- These run under plain `npm test` with no database

### Integration Tests:

- Schema/grant behaviour: column-scoped insert refuses a client-supplied `id`/`created_at`; no update grant exists; the enum rejects an out-of-range value
- Tenant isolation: cross-tenant select/insert/delete denial with a service-role re-read proving the row is untouched, plus a positive control
- Source integrity: `source = 'form'` refused for an authenticated owner, `'manual'` accepted
- These require `npm run test:remote` (the `requireLocalDb` guard, finding F1)

### Not covered by automated tests:

- The Server Actions themselves — Vitest runs without a Next runtime, so `createSubmission` and `deleteSubmission` are unreachable from the suite, exactly as `deleteAccount` is. The database half is covered above; the `company_id`-from-session invariant rests on code review.
- The inline two-step confirm UI — no component test runner is configured.

### Manual Testing Steps:

1. Sign in, open `/dashboard`, confirm the submission count reads sensibly at zero and links to the page
2. Add a submission; confirm it appears with a manual-source badge and the form clears
3. Submit empty content; confirm an inline error and no new row
4. Add a second submission; confirm ordering is newest-first
5. Delete one: click Delete, confirm the row arms, hit Cancel, confirm nothing was deleted
6. Delete again and confirm; the row disappears and the dashboard count drops
7. Hard-reload; the deleted submission stays gone
8. Sign in as a second owner; confirm their list is empty and unaffected by the first owner's data
9. Delete the second account; confirm its submissions go with it

## Performance Considerations

The `(company_id, created_at desc)` index matches the list query's filter and sort exactly, so the capped read is an index scan regardless of table size. The count is a separate `head: true` query — exact counts are a sequential scan on very large tables, which is irrelevant at MVP volumes but is the first thing to revisit if a tenant ever accumulates tens of thousands of submissions. The 100-row cap keeps the page payload bounded independently of how much the count grows.

## Migration Notes

Forward-only and purely additive: a new enum, a new table, and its policies/grants/index. Nothing existing is altered, so no data migration and no backfill. `.env.local` points at the linked cloud project, so `supabase db push` is the path; `db reset` would wipe live data and is only appropriate against a local instance.

The one non-additive consequence is the `on delete cascade` from `submissions.company_id`: account deletion now destroys submissions too. That is intended and required (without it the cascade from `auth.users` fails on the FK), but it widens what `deleteAccount` erases — flagged in the S-01 brief as something to watch, and now realised.

## References

- Roadmap slice S-02: `context/foundation/roadmap.md:101-111`
- Isolation primitive: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:61-75`
- Grant narrowing precedent: `supabase/migrations/20260730190000_narrow_company_write_grants.sql`
- Read/write DAL convention: `src/lib/dal.ts:27-50`, `src/app/dashboard/company/actions.ts:41-71`
- Form + action pattern to mirror: `src/app/dashboard/company/company-profile-form.tsx`
- Test harness to extend: `tests/isolation.test.ts:38-96`, `tests/schema.test.ts:44-79`
- Recurring rules applied: `context/foundation/lessons.md`
- Prior slice for structure: `context/changes/company-profile/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Schema Migration (enum, table, RLS, grants, index)

#### Automated

- [x] 1.1 `npx supabase migration list --linked` shows the migration applied remotely
- [ ] 1.2 Replay from empty (`npx supabase db reset`) — BLOCKED, no container runtime; record, do not tick by inference
- [x] 1.3 Schema assertions pass, including the four privilege negatives (`npm run test:remote`)
- [x] 1.4 Generated types include `submissions` and `submission_source`
- [x] 1.5 Linting passes (`npm run lint`)

#### Manual

- [x] 1.6 Studio shows RLS enabled with three policies and no update policy
- [x] 1.7 `authenticated` has select, delete, and column-scoped insert — no update
- [x] 1.8 `anon` has no privileges on `submissions` at all
- [x] 1.9 Deleting a test auth user removes that user's submissions

### Phase 2: Validation + Data Access Contract

#### Automated

- [ ] 2.1 Type checking passes (`npx tsc --noEmit`)
- [ ] 2.2 Unit tests pass (`npm test`)
- [ ] 2.3 Linting passes (`npm run lint`)
- [ ] 2.4 `getSubmissions()` returns `source` typed as `'manual' | 'form'`

#### Manual

- [ ] 2.5 `getSubmissions()` returns only the caller's rows with two owners seeded

### Phase 3: Add + List Surface

#### Automated

- [ ] 3.1 Type checking passes (`npx tsc --noEmit`)
- [ ] 3.2 Linting passes (`npm run lint`)
- [ ] 3.3 Build succeeds (`npm run build`)
- [ ] 3.4 Existing suites still pass (`npm run test:remote`)

#### Manual

- [ ] 3.5 Added submission appears top of list with manual badge and date
- [ ] 3.6 Form clears after a successful add; a second add works without reload
- [ ] 3.7 Empty/whitespace content shows an inline error and saves nothing
- [ ] 3.8 A rejected submission keeps the owner's typed content in the textarea
- [ ] 3.9 2000 chars saves; the textarea refuses more
- [ ] 3.10 A new account sees the empty state
- [ ] 3.11 Dashboard count matches the list and updates after an add
- [ ] 3.12 Logged-out visit to `/dashboard/submissions` redirects to `/login`

### Phase 4: Delete Path

#### Automated

- [ ] 4.1 Type checking passes (`npx tsc --noEmit`)
- [ ] 4.2 Linting passes (`npm run lint`)
- [ ] 4.3 Build succeeds (`npm run build`)

#### Manual

- [ ] 4.4 Delete arms only the clicked row
- [ ] 4.5 Cancel disarms and deletes nothing
- [ ] 4.6 Confirm removes the row and decrements the dashboard count
- [ ] 4.7 The deletion survives a hard reload
- [ ] 4.8 Arm, confirm, and cancel all reachable by keyboard

### Phase 5: Isolation & Forgery Verification

#### Automated

- [ ] 5.1 All suites pass (`npm run test:remote`)
- [ ] 5.2 Denial tests spot-checked as capable of failing
- [ ] 5.3 Linting passes (`npm run lint`)

#### Manual

- [ ] 5.4 Two owner sessions show disjoint submission lists
- [ ] 5.5 Owner B's direct PostgREST call against owner A's submission returns nothing
