# Company Profile — Owner CRUD for Company Data — Implementation Plan

## Overview

Roadmap slice **S-01**. Turn the F-01 tenant record — a `companies` row that today carries only a nullable `name` — into an editable company profile the owner can view, complete, and erase. Four fields (`name`, `industry`, `description`, `location`) are deliberately shaped as **structured LLM context for S-03's action-plan prompt**, so the north-star slice inherits a ready-made company-context block instead of needing its own migration and prompt rewrite.

The isolation contract is not rebuilt here — it is **inherited** from F-01 and, for the first time, **exercised on a write path**. This slice is where an owner first mutates tenant data, so proving that owner B cannot UPDATE or DELETE owner A's row is part of the deliverable, not an afterthought.

## Current State Analysis

- **The tenant row already exists and is already isolated.** `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:15` creates `public.companies` (`id`, `owner_id`, `name`, `created_at`, `updated_at`) with `owner_id uuid not null unique references auth.users(id) on delete cascade`. All four RLS policies exist and are keyed on `owner_id = (select auth.uid())` — including `companies_update_own` (`:41`) and `companies_delete_own` (`:47`).
- **Rows are auto-provisioned blank.** `handle_new_user()` (`:81`) inserts one `companies` row per new `auth.users` row with `owner_id` only. Every owner therefore starts with a **completely empty profile** — `name` is NULL from day one.
- **The read path exists.** `src/lib/dal.ts:32` `getCompany()` selects `id, name, created_at` through the RLS-scoped session client with `.maybeSingle()` and **no explicit owner filter** — RLS is what scopes it. `verifySession()` (`:14`) is the auth gate every data path calls first.
- **The surface is a placeholder.** `src/app/dashboard/page.tsx:26` renders `company.name` with a "Not set yet" fallback and a logout button. Nothing writes to the table anywhere in the codebase.
- **The form pattern is established.** `src/app/login/login-form.tsx:8` uses `useActionState`; `src/app/login/actions.ts:18` validates with Zod `safeParse` and returns `{ errors: ... }` / `{ message: ... }`; `src/lib/validation.ts:21` exports the shared `FormState` type. Zod v4 (`package.json:19`).
- **The test harness is real.** `tests/isolation.test.ts` provisions two live owners against a real Supabase project and asserts read isolation in both directions. Vitest is configured (`vitest.config.ts`) with `loadEnv` pulling `.env.local` and a 30s timeout for network round trips.
- **Target database is the linked cloud project**, not a local instance — `.env.local` points at `https://xiptmbgebztcnkolradl.supabase.co` and nothing is listening on `127.0.0.1:54321`.

### Key Discoveries:

- **`updated_at` is stale by construction.** `20260726104601_owner_auth_tenant_isolation.sql:20` gives it `default now()` but there is **no BEFORE UPDATE trigger**, so it is frozen at insert time. This slice is the first to issue an UPDATE, so it is the first to expose the bug.
- **The table has no explicit `GRANT`s.** The F-01 migration never grants table privileges to `authenticated`, and `supabase/config.toml:20` documents that new entities are **not** auto-exposed to the Data API roles when the setting is unset. Reads work against the linked project today, but this slice is the first to depend on the **UPDATE** privilege — that must be granted explicitly rather than assumed.
- **RLS write denial is silent.** A cross-tenant UPDATE or DELETE matches zero rows and returns **success with an empty result set**, not an error. Any isolation assertion that only checks `error` would pass against a table with the policies dropped.
- **Server Actions bypass the proxy matcher** (F-01 key discovery, confirmed at `node_modules/next/dist/docs/01-app/02-guides/forms.md:10`: *"Always verify authentication and authorization inside each Server Action, even if the form is only rendered on an authenticated page"*). Every action in this slice calls `verifySession()` first.
- **Supabase has no self-service user deletion on the anon key.** Removing the auth user requires `createAdminClient()` (`src/lib/supabase/server.ts:40`), which **bypasses RLS entirely** — the one place in this slice where the isolation guarantee rests on application code rather than Postgres.

## Desired End State

An authenticated owner opens `/dashboard/company`, sees their current company profile, fills in name / industry / description / location, and saves — with inline field errors, a pending state, and a saved confirmation. The dashboard links to the page and tells them when the profile is incomplete. A separate, type-to-confirm destructive control permanently deletes their account: the `auth.users` row is removed, the `companies` row goes with it via `ON DELETE CASCADE`, the session is cleared, and they land back on `/login`. An extended two-tenant test proves owner B can neither read, update, nor delete owner A's company.

**Verification of end state:** `npm run build`, `npm run lint`, `npx tsc --noEmit` all clean; `npm test` green including the new write-isolation and schema assertions; manual round trip of edit → save → reload → delete account → redirected to `/login`.

### Key Decisions (all confirmed during planning):

| Area | Decision |
| --- | --- |
| Field set | `name`, `industry`, `description`, `location` — sized as S-03 prompt context, no contact/branding fields. |
| Extra scope driver | Company context feeds S-03's action-plan prompt; shape it once, here. |
| Destructive semantics | **Delete the auth user**; `ON DELETE CASCADE` removes the company row. Not a field clear. |
| Delete confirmation | Type-to-confirm (owner types the company name) — erasure is irreversible with no backup path. |
| Required fields | All four required **at the Zod layer**; DB columns stay nullable because rows are auto-provisioned blank. |
| Surface location | `/dashboard/company` — inherits the existing `/dashboard` prefix guard in `src/proxy.ts:7`. |
| Feedback | `useActionState` inline status, mirroring the login form. |
| Schema gaps | Fix both: add the `updated_at` BEFORE UPDATE trigger **and** explicit `GRANT`s. |
| Migration path | `supabase db push` to the linked cloud project; forward-only, additive DDL. |
| Testing | Extend `tests/isolation.test.ts` to write paths (UPDATE + DELETE denial) plus Zod unit tests. |
| Dashboard wiring | Link to the profile page plus a completeness empty state. |
| Cut order | Phase 5 (account deletion) is last; everything before it is a complete, shippable FR-002 slice. |

## What We're NOT Doing

- **Contact or branding fields** (website, phone, email, logo) — inert for plan generation; a logo would pull in Supabase Storage and its own RLS policies.
- **An onboarding gate** that forces profile completion before the dashboard is reachable — explicitly declined; the empty state nudges, it does not trap.
- **Toast/global notification infrastructure** — no library is present and `useActionState` covers this slice.
- **Profile history, versioning, or soft delete** — no audit table; erasure is permanent by design.
- **Submissions or plans tables** (S-02/S-03) and the public form (S-05/S-06).
- **Rebuilding isolation** — F-01's RLS pattern is inherited as-is; this slice extends its *proof*, not its mechanism.
- **Reworking `/dashboard` into a real shell** — S-02 will do that; here it gets a link and an empty state only.

## Implementation Approach

Bottom-up, mirroring F-01 so the risky work is bracketed by verification. **(1)** Land the schema delta — new columns plus the two F-01 gaps (`updated_at` trigger, explicit grants) — as one additive migration. **(2)** Define the validation and data-access contract the surface will consume. **(3)** Build the profile page and write path. **(4)** Lock write isolation behind automated two-tenant tests *before* the destructive path exists. **(5)** Add account deletion last — the most security-sensitive code, landing on top of a suite that already proves cross-tenant writes are denied.

## Critical Implementation Details

- **Service-role in a user-facing path (load-bearing).** `deleteAccount` is the only place `createAdminClient()` touches an owner request, and it bypasses RLS completely. The user id **must** come from `verifySession()` and never from `FormData`, a query param, or a hidden input — an id read from the request would let any authenticated owner delete any account. The typed confirmation value is a UI guard only and must be re-validated server-side against the profile the session owns.
- **`redirect()` throws.** Next's `redirect()` signals via a thrown `NEXT_REDIRECT` error, so calling it inside a `try` block gets swallowed by the `catch`. In `deleteAccount`, do the deletion and `signOut()` inside the guarded block and call `redirect('/login')` **after** it.
- **Ordering in `deleteAccount`, and why the sign-out must be local.** Delete the auth user first, then sign out, then redirect. Skipping the sign-out leaves a cookie for a user that no longer exists, so the next request 401s from a stale session rather than landing cleanly on `/login`. Critically, it must be **`signOut({ scope: 'local' })`** — the default `global` scope calls Supabase's logout endpoint for a user that was just deleted, which can error. If that error is treated as a failure, the owner sees "deletion failed" while holding a live cookie for an account that is already gone. Once `deleteUser` succeeds the deletion is final: treat any sign-out error as non-fatal and always proceed to the redirect. (`scope` is available on `SignOut` — `node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:1555`.)
- **Silent write denial in tests.** Cross-tenant UPDATE/DELETE returns `{ data: [], error: null }`. Assertions must re-read the target row **through the service-role admin client** and confirm it is byte-for-byte unchanged (and still present). Checking only `error` would pass with the policies dropped — the exact failure mode the F-01 negative control was designed to catch.
- **`updated_at` trigger must be BEFORE UPDATE, not BEFORE INSERT OR UPDATE** — the column already has `default now()`, and firing on insert would fight the auto-provisioning trigger for no benefit.

---

## Phase 1: Schema Migration (profile columns, updated_at trigger, grants)

### Overview

One additive migration that extends `public.companies` with the three new profile columns and closes the two gaps F-01 left behind. Applied forward-only to the linked cloud project.

### Changes Required:

#### 1. Profile columns

**File**: `supabase/migrations/<timestamp>_company_profile.sql` (generate with `npx supabase migration new company_profile`)

**Intent**: Add the three fields that join the existing `name` to form the S-03 prompt context block. Nullable, because `handle_new_user()` provisions rows blank and existing rows must survive the migration.

**Contract**: `alter table public.companies` adding `industry text`, `description text`, `location text` — all nullable, no defaults. Existing rows keep their data. Add a `comment on column` for each noting its role as plan-generation context.

#### 2. `updated_at` maintenance trigger

**File**: same migration

**Intent**: Make `updated_at` mean what it says. It is currently frozen at insert time, and this slice introduces the first UPDATE.

**Contract**: A `BEFORE UPDATE` trigger function on `public.companies` that sets `new.updated_at = now()` and returns `new`. Follows F-01's SECURITY hygiene: explicit `set search_path = ''` with schema-qualified names.

#### 3. Explicit table privileges

**File**: same migration

**Intent**: Guarantee the `authenticated` role can actually write, rather than relying on whatever default-privilege behavior the linked project happens to have. RLS restricts *which rows*; grants decide *whether the verb is allowed at all*.

**Contract**: `grant select, insert, update, delete on public.companies to authenticated;`. Idempotent and harmless if the privileges already exist. Do **not** grant to `anon` — the public form (S-06) will get its own scoped path.

#### 4. Committed schema assertion test

**File**: `tests/schema.test.ts`

**Intent**: Make the schema criteria runnable rather than described, and keep them in CI.

> **Adaptation (approved during implementation, 2026-07-29).** This was originally specified as `supabase/tests/company_profile_schema_check.sql` run via `psql "$SUPABASE_DB_URL"`, following F-01's pattern. That is not executable here: `psql` is not installed and `SUPABASE_DB_URL` is set neither in the shell nor in `.env.local` — the exact blind spot recorded as F5 in the plan review. F-01's own script carries an "or paste into the Supabase SQL editor" note, so that pattern was manual in practice while being written up as automated. PostgREST also exposes only the `public` schema, so `information_schema` is unreachable through supabase-js regardless. The assertions are therefore **behavioural**, which is stronger evidence for the grant anyway: an authenticated UPDATE that actually succeeds proves the privilege more directly than reading `role_table_grants`.

**Contract**: A Vitest suite against the linked project, mirroring the setup pattern in `tests/isolation.test.ts` (admin client provisions a confirmed user, the `on_auth_user_created` trigger provisions the company, teardown deletes the user and the row cascades). Asserts: the three new columns are selectable; they are NULL on a freshly provisioned row; an UPDATE advances `updated_at` past both its previous value and `created_at`; and an **authenticated owner** — not the service role — can UPDATE their own row, which is what proves the `GRANT`.

### Success Criteria:

#### Automated Verification:

- Migration applies to the linked project: `npx supabase db push`
- Schema assertions pass: `npx vitest run tests/schema.test.ts` (covers the new columns being present and nullable, `updated_at` advancing on UPDATE, and the `authenticated` UPDATE grant proven by a real owner write)
- Lint passes: `npm run lint`

#### Manual Verification:

- In Supabase Studio, existing `companies` rows still carry their prior `owner_id` and `name` values (additive migration lost nothing)

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: Validation + Data Access Contract

### Overview

Define the shapes the surface will consume: a Zod schema requiring all four fields, a completeness predicate the dashboard uses for its empty state, and a widened DAL read.

### Changes Required:

#### 1. Company profile schema

**File**: `src/lib/validation.ts`

**Intent**: Enforce "all four required" at the application layer while the DB columns stay nullable, and cap lengths so a pathological paste cannot bloat the S-03 prompt.

**Contract**: Export `CompanyProfileSchema` — an object of `name`, `industry`, `description`, `location`, each trimmed and non-empty with a field-specific message. Length caps are **explicit**, because they are an S-03 prompt-token budget rather than a cosmetic choice: `name`, `industry`, `location` at 120 characters; `description` at 2000. Export the inferred `CompanyProfileInput` type.

Make `FormState` **generic** rather than widening the existing shape — `FormState<TFields extends string>` with `errors?: Partial<Record<TFields, string[]>>` and the existing optional `message`. Otherwise every future form's field keys accumulate in one type and the login form ends up advertising a `location` error it can never produce. Existing usage in `src/app/login/actions.ts` and `src/app/login/login-form.tsx` adapts by supplying one type argument (`FormState<'email'>`).

#### 2. Completeness predicate

**File**: `src/lib/validation.ts`

**Intent**: One shared definition of "profile is incomplete" so the dashboard empty state and the profile page cannot drift apart.

**Contract**: Export `isCompanyProfileComplete(company)` returning true only when all four fields are present and non-blank. Accepts the nullable-field row shape the DAL returns.

#### 3. Widened company read

**File**: `src/lib/dal.ts`

**Intent**: Surface the new columns to every consumer. The existing RLS-scoped, filter-free `.maybeSingle()` query is unchanged in shape — only the column list grows.

**Contract**: `getCompany()` selects `id, name, industry, description, location, created_at, updated_at`. No owner filter is added — RLS remains the scoping mechanism, per the F-01 contract. This filter-free convention applies to **reads only**; see Phase 3 for why the write path does not inherit it.

#### 4. Schema unit tests

**File**: `tests/validation.test.ts`

**Intent**: Pin the validation contract the surface depends on. These live here, with the code they cover, rather than in the verification phase — otherwise Phase 2's only automated evidence is that it compiles, which is true of any phase that doesn't break the build.

**Contract**: Pure unit tests, no network. Cases asserting `CompanyProfileSchema` rejects each field when blank or whitespace-only, rejects input past its cap (120 / 2000), accepts a valid payload, and trims surrounding whitespace. Cases asserting `isCompanyProfileComplete` is false for a blank or partially filled row and true for a full one.

### Success Criteria:

#### Automated Verification:

- Type check passes: `npx tsc --noEmit`
- Production build passes: `npm run build`
- Lint passes: `npm run lint`
- Schema unit tests pass without network access: `npx vitest run tests/validation.test.ts`

#### Manual Verification:

- `/dashboard` still renders the company card without runtime error after the DAL widening

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 3.

---

## Phase 3: Profile Surface (view + edit)

### Overview

The owner-facing feature: a protected `/dashboard/company` route rendering the current profile in an editable form, the Server Action that persists it, and the dashboard wiring that makes it discoverable.

### Changes Required:

#### 1. Profile page

**File**: `src/app/dashboard/company/page.tsx`

**Intent**: Server component that loads the owner's company via the DAL and hands it to the client form as initial values. Sits under `/dashboard`, so `src/proxy.ts:7` already guards it with no config change.

**Contract**: Async server component calling `getCompany()`, rendering a heading and the `CompanyProfileForm` with the row as its `company` prop. Handles the null-company case with the same defensive message the dashboard uses. Styling follows the existing card pattern in `src/app/dashboard/page.tsx`.

#### 2. Profile form

**File**: `src/app/dashboard/company/company-profile-form.tsx`

**Intent**: The editable surface with inline validation feedback, mirroring the login form's established pattern.

**Contract**: `'use client'` component taking the company row as a prop and using `useActionState(updateCompanyProfile, undefined)`. Inputs for the four fields (`description` as a `textarea`) pre-filled with `defaultValue` from the row, each rendering its own `state.errors[field]` message. Submit button disabled while pending; `state.message` rendered in an `aria-live="polite"` region.

#### 3. Update Server Action

**File**: `src/app/dashboard/company/actions.ts`

**Intent**: Validate and persist the profile as the logged-in owner, so RLS scopes the write.

**Contract**: `'use server'` action `updateCompanyProfile(prevState, formData)` that calls `verifySession()` **first** (Server Actions bypass the proxy), `safeParse`s the four fields with `CompanyProfileSchema`, returns `{ errors }` on failure, then issues an `update` on `companies` through the **session** client, filtered by `.eq('owner_id', user.id)` using the id from `verifySession()`. Calls `revalidatePath` (from `next/cache`) for `/dashboard/company` and `/dashboard` on success and returns a confirmation message. Maps a Postgres error to a generic message without leaking driver detail.

**Why the explicit filter**, when the read path deliberately omits one: the failure modes are not symmetric. An unfiltered SELECT that over-matches leaks data; an unfiltered UPDATE that over-matches **rewrites every visible row**. RLS remains the security boundary — the filter is the seatbelt that bounds the blast radius if a policy is ever widened or the wrong client is ever passed in. Do not "simplify" it away for consistency with `getCompany()`.

#### 4. Dashboard link + completeness state

**File**: `src/app/dashboard/page.tsx`

**Intent**: Make the profile reachable and tell the owner when it needs attention — every new account starts blank, so without this the dashboard is a dead end.

**Contract**: Render the profile summary using the widened row, a `next/link` to `/dashboard/company`, and — when `isCompanyProfileComplete()` is false — a prompt to complete the profile. Existing logout control unchanged.

### Success Criteria:

#### Automated Verification:

- Production build passes: `npm run build`
- Lint passes: `npm run lint`
- Type check passes: `npx tsc --noEmit`

#### Manual Verification:

- `/dashboard/company` renders with current values pre-filled; saving all four fields shows the confirmation and the values survive a reload
- Submitting with any field blank shows that field's inline error and persists nothing
- `/dashboard` shows the completeness prompt for a blank profile and the summary once complete, with a working link to the profile page
- Logged-out access to `/dashboard/company` redirects to `/login`

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 4.

---

## Phase 4: Write-Isolation Verification

### Overview

Extend the two-tenant harness from read-only to write coverage. This is the executable guard on the first owner write path, and it lands **before** the destructive action exists so the delete phase builds on a proven floor.

### Changes Required:

#### 1. Cross-tenant write assertions

**File**: `tests/isolation.test.ts`

**Intent**: Prove owner B can neither modify nor remove owner A's company. Read isolation is already covered; the write verbs this slice introduces are not.

**Contract**: New cases in the existing `describe`, reusing the `createOwner` helper and the two-owner `beforeAll`. Seed owner A's profile via the admin client, then as owner B attempt (a) an `update` targeting A's `id` and (b) a `delete` targeting A's `id`. After each, re-read A's row **through the admin client** and assert it still exists with unchanged field values — the denial is silent, so asserting on `error` alone proves nothing. Add a positive control: owner A updating their own row succeeds and `updated_at` advances.

### Success Criteria:

#### Automated Verification:

- Full suite green: `npm test`
- Cross-tenant UPDATE denied **and** the target row verified unchanged via the admin client
- Cross-tenant DELETE denied **and** the target row verified still present via the admin client
- Positive control passes: an owner updating their own row succeeds and advances `updated_at`

#### Manual Verification:

- Negative control: temporarily drop `companies_update_own`, confirm the cross-tenant UPDATE assertion **fails**, then restore the policy (proves the test exercises RLS rather than absence)

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 5.

---

## Phase 5: Account Deletion

### Overview

The destructive path: permanent erasure of the owner's account, taking the company row with it via `ON DELETE CASCADE`. The most security-sensitive code in the slice — the only place a service-role client serves a user request.

### Changes Required:

#### 1. Type-to-confirm control

**File**: `src/app/dashboard/company/delete-account-form.tsx`

**Intent**: Make irreversible erasure require deliberate intent. There is no undo, no backup, and no history table in the MVP.

**Contract**: `'use client'` component in a visually distinct destructive section, separate from the profile form. A text input whose value must exactly match the company name (or a fixed sentinel when the name is blank) before the submit button enables. Uses `useActionState(deleteAccount, undefined)` for pending state and error display. States plainly what will be destroyed.

#### 2. Delete Server Action

**File**: `src/app/dashboard/company/actions.ts`

**Intent**: Remove the `auth.users` row so the cascade takes the company with it, then clear the session and return the visitor to `/login`.

**Contract**: `'use server'` action `deleteAccount(prevState, formData)`. Calls `verifySession()` first and takes the user id **exclusively** from its return value. Re-validates the typed confirmation server-side against the session's own company before proceeding. Calls `createAdminClient().auth.admin.deleteUser(user.id)`, then `signOut({ scope: 'local' })` on the session client, then `redirect('/login')` **outside** any try/catch (see Critical Implementation Details). Returns a state message only if `deleteUser` itself fails.

**Verification boundary (read before writing the test you are about to want).** The invariant "the deleted id comes from the session, never from input" is **not automatically testable in this repo**. `tests/isolation.test.ts` runs under `environment: 'node'` (`vitest.config.ts`) with no Next runtime: importing this `'use server'` module yields a plain async function whose `verifySession()` calls `cookies()` from `next/headers`, which throws outside a request scope. The database-layer half of the guarantee — that cross-tenant DELETE is denied — is already covered by Phase 4. What remains is a **code-review invariant**: the id passed to `deleteUser` must be traceable to `verifySession()` on the same line of reasoning, with no `FormData`, query param, or hidden input anywhere in its provenance. Do not add a phase-5 test that appears to cover this but actually asserts something else.

### Success Criteria:

#### Automated Verification:

- Production build passes: `npm run build`
- Lint passes: `npm run lint`
- Type check passes: `npx tsc --noEmit`
- Full suite green: `npm test` (no new cases — see the verification boundary above)

#### Manual Verification:

- The submit button stays disabled until the confirmation text matches exactly
- Confirming deletion signs the owner out and lands them on `/login`
- The `companies` row for that owner is gone from Supabase Studio (cascade fired) and the `auth.users` row is gone
- Signing in again with the same email creates a **fresh** account with a new blank company row (the `on_auth_user_created` trigger re-provisions), and no data from the deleted account is visible
- A second owner's data is untouched by the deletion

**Implementation Note**: After this phase, the slice is complete; commit and record SHAs in Progress.

---

## Testing Strategy

### Unit Tests:

- `CompanyProfileSchema`: blank / whitespace-only / over-cap rejection per field, trimming, valid payload acceptance (`tests/validation.test.ts`, landed in Phase 2 alongside the schema itself).
- `isCompanyProfileComplete`: blank, partial, and complete rows.

### Integration Tests:

- Two-tenant write isolation against a real Supabase instance (`tests/isolation.test.ts`, Phase 4): cross-tenant UPDATE and DELETE denied with the target row verified unchanged via the service-role client; own-row update succeeds and advances `updated_at`.

### Not covered by automated tests:

- **The `deleteAccount` Server Action.** Vitest runs without a Next runtime, so the action is unreachable from the suite (see Phase 5's verification boundary). Its DB-layer guarantee is covered by Phase 4's cross-tenant DELETE denial; the "id comes from the session" invariant is enforced by code review, not by a test.

### Manual Testing Steps:

1. Apply the migration with `npx supabase db push` and confirm in Studio that existing rows survived.
2. Sign in, open `/dashboard/company`, and confirm current values are pre-filled.
3. Save with one field blank → inline error, nothing persisted.
4. Save all four → confirmation message; reload and confirm values persisted and `updated_at` advanced.
5. Return to `/dashboard` → completeness prompt gone, summary and link present.
6. Type a mismatched confirmation in the delete section → button stays disabled.
7. Type the exact confirmation and delete → signed out, on `/login`; company and auth rows gone from Studio.
8. Sign in again with the same email → fresh blank company, none of the old data.

## Performance Considerations

Negligible at MVP scale. The profile page adds one RLS-scoped single-row read per request, already memoized by `cache()` in the DAL. `revalidatePath` after save invalidates only the two dashboard routes. The isolation suite adds live network round trips — covered by the existing 30s Vitest timeout.

## Migration Notes

- **Forward-only against the live cloud project.** `.env.local` targets the linked Supabase project and no local instance is running, so `supabase db push` applies DDL to the working database. `supabase db reset` is **not** a safe verification path here — it would wipe live data. The migration is purely additive (new nullable columns, a trigger, grants) so it carries no data-loss risk; rollback is a new compensating migration, never an edit to an applied file.
- **Grants are intentionally re-stated.** The `grant` is harmless if the privileges already exist, and it makes the requirement explicit in the repo rather than dependent on project-level default-privilege behavior.
- **Account deletion is irreversible and has no export path.** Deleting the `auth.users` row cascades to `companies` and — once S-02/S-03 land — will cascade to submissions and plans too. Worth revisiting as a RODO data-export requirement before production.
- This slice **exceeds FR-003 as literally worded** ("usunąć informacje o firmie" = delete company *info*). Full account erasure was chosen deliberately: the flat 1-account-1-company model means deleting only the company row would orphan the tenant, leaving a signed-in owner whose `current_company_id()` is NULL with no way to recover — the auto-provisioning trigger fires only on user insert. Erasure also aligns with the RODO NFR.

## References

- Roadmap item: `context/foundation/roadmap.md` (S-01, lines 89–99)
- PRD: `context/foundation/prd.md` (FR-002, FR-003, Business Logic, NFR RODO/izolacja)
- Predecessor slice: `context/changes/owner-auth-tenant-isolation/plan.md` (isolation contract inherited here)
- F-01 migration: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql`
- Existing read path: `src/lib/dal.ts:32`
- Form pattern to mirror: `src/app/login/login-form.tsx`, `src/app/login/actions.ts`
- Fork docs — forms + Server Action auth warning: `node_modules/next/dist/docs/01-app/02-guides/forms.md:10`
- Fork docs — proxy convention: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema Migration (profile columns, updated_at trigger, grants)

#### Automated

- [x] 1.1 Migration applies to the linked project: `npx supabase db push`
- [x] 1.2 Schema assertions pass: `npx vitest run tests/schema.test.ts`
- [x] 1.3 Lint passes: `npm run lint`

#### Manual

- [x] 1.4 Existing companies rows retain owner_id and name after the migration

### Phase 2: Validation + Data Access Contract

#### Automated

- [ ] 2.1 Type check passes: `npx tsc --noEmit`
- [ ] 2.2 Production build passes: `npm run build`
- [ ] 2.3 Lint passes: `npm run lint`
- [ ] 2.4 Schema unit tests pass without network access: `npx vitest run tests/validation.test.ts`

#### Manual

- [ ] 2.5 `/dashboard` still renders the company card after the DAL widening

### Phase 3: Profile Surface (view + edit)

#### Automated

- [ ] 3.1 Production build passes: `npm run build`
- [ ] 3.2 Lint passes: `npm run lint`
- [ ] 3.3 Type check passes: `npx tsc --noEmit`

#### Manual

- [ ] 3.4 `/dashboard/company` pre-fills current values; saving all four persists across reload
- [ ] 3.5 A blank field shows its inline error and persists nothing
- [ ] 3.6 `/dashboard` shows the completeness prompt when blank, summary when complete, with a working link
- [ ] 3.7 Logged-out access to `/dashboard/company` redirects to `/login`

### Phase 4: Write-Isolation Verification

#### Automated

- [ ] 4.1 Full suite green: `npm test`
- [ ] 4.2 Cross-tenant UPDATE denied and target row verified unchanged via admin client
- [ ] 4.3 Cross-tenant DELETE denied and target row verified still present via admin client
- [ ] 4.4 Positive control: own-row update succeeds and advances updated_at

#### Manual

- [ ] 4.5 Negative control: dropping companies_update_own makes the cross-tenant UPDATE assertion fail, then restore

### Phase 5: Account Deletion

#### Automated

- [ ] 5.1 Production build passes: `npm run build`
- [ ] 5.2 Lint passes: `npm run lint`
- [ ] 5.3 Type check passes: `npx tsc --noEmit`
- [ ] 5.4 Full suite green: `npm test`

#### Manual

- [ ] 5.5 Submit stays disabled until the confirmation text matches exactly
- [ ] 5.6 Confirming deletion signs the owner out and lands on `/login`
- [ ] 5.7 Both the companies row and the auth.users row are gone from Studio
- [ ] 5.8 Re-signing in with the same email creates a fresh blank company with no old data
- [ ] 5.9 A second owner's data is untouched by the deletion
