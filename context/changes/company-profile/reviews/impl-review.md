<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Company Profile — Owner CRUD for Company Data

- **Plan**: `context/changes/company-profile/plan.md`
- **Scope**: Full plan — Phases 1–5 of 5 (all Progress boxes `[x]`)
- **Date**: 2026-07-30
- **Verdict**: NEEDS ATTENTION → **all findings triaged and fixed** (see Post-triage state)
- **Findings**: 1 critical, 6 warnings, 4 observations — 11 total, 11 FIXED
- **Diff range**: `6f24dc3..25f65fb` (judged at HEAD `ac0913c`)

> F11 was discovered *during* triage, while applying F1's fix. It is the most serious finding in the review and did not exist in the original report.

## Verdicts

| Dimension | At review | After triage |
|-----------|-----------|--------------|
| Plan Adherence | PASS | PASS |
| Scope Discipline | PASS | PASS |
| Safety & Quality | WARNING | PASS |
| Architecture | WARNING | PASS |
| Pattern Consistency | WARNING | PASS |
| Success Criteria | FAIL | PASS |

## Post-triage state

All eleven findings were fixed. Final verification, 2026-07-30:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |
| `npm run test:remote` | **50/50 green, 3 suites** |
| `npx supabase migration list --linked` | all 5 migrations applied locally **and** remotely |

`npm test` (without the opt-in) still aborts the two DB suites at the `requireLocalDb` guard — deliberate, per the F1 decision. The guard stays armed by default; `npm run test:remote` is the explicit opt-in. Closing that properly requires a container runtime, which this machine does not have.

**Files changed during triage**: `package.json`, `src/app/dashboard/company/actions.ts`, `src/app/dashboard/company/company-profile-form.tsx`, `src/app/dashboard/company/delete-account-form.tsx`, `src/app/dashboard/error.tsx` (new), `src/lib/account-deletion.ts` (new), `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/database.types.ts` (new, generated), `src/lib/validation.ts`, `supabase/migrations/20260730190000_narrow_company_write_grants.sql` (new), `tests/isolation.test.ts`, `tests/validation.test.ts`, `vitest.config.ts`.

### Verification run (2026-07-30)

| Criterion | Result |
|---|---|
| `npm run lint` | PASS — clean |
| `npx tsc --noEmit` | PASS — clean |
| `npm run build` | PASS — 6 routes compiled, `/dashboard/company` present |
| `npm test` | **FAIL** — 34 unit tests pass; `tests/isolation.test.ts` and `tests/schema.test.ts` abort at the `requireLocalDb` guard |
| `npx supabase db push` | Not run — mutating DDL against the live linked project |

### Plan adherence detail

Every planned item across all five phases is present and matches intent — no MISSING, no major DRIFT. The two load-bearing security invariants hold under inspection:

- `deleteAccount` (`src/app/dashboard/company/actions.ts:87-110`) takes the user id **exclusively** from `verifySession()`. `formData` is read only for the confirmation phrase. `redirect('/login')` (`:136`) is outside any try/catch. `signOut({ scope: 'local' })` (`:126`) with a non-fatal error path (`:127-132`).
- `updateCompanyProfile` calls `verifySession()` first (`:26`) and keeps the explicit `.eq('owner_id', user.id)` seatbelt (`:51`).

Benign extras beyond the contract, none crossing a "What We're NOT Doing" guardrail: `COMPANY_PROFILE_FIELDS`/`CompanyProfileField` exports, `accountDeletionPhrase()` hoisted into `validation.ts` (see F7), a "← Back to dashboard" link, `maxLength` attributes mirroring the Zod caps, and extra boundary/trim test cases.

## Findings

### F1 — `npm test` fails at HEAD; the write-isolation proof is dormant

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Success Criteria
- **Location**: `tests/support/require-local-db.ts:21`, `tests/isolation.test.ts:31`, `tests/schema.test.ts:32`
- **Detail**: Progress boxes 4.1 and 5.4 claim `npm test` green, and they were at `d9d8eb2`/`0384391`. At HEAD it exits non-zero: both integration suites abort before collecting a single test — *"refuses to run against xiptmbgebztcnkolradl.supabase.co … Point NEXT_PUBLIC_SUPABASE_URL at a local Supabase, or set ALLOW_REMOTE_TEST_DB=1"*. There is no `.env.test.local` in the repo root and nothing is listening on `127.0.0.1:54321`, so the guard cannot currently be satisfied. Net effect: Phase 4's cross-tenant UPDATE/DELETE denial tests — described in the plan Overview as *"part of the deliverable, not an afterthought"* and the executable proof of PRD FR-001 on this slice's first write path — never execute. Only the 34 pure unit tests run. Not caused by this change: the guard arrived in `ac0913c` from the `owner-auth-tenant-isolation` review. Severity is WARNING rather than CRITICAL because no assertion fails — the suites refuse to start at a deliberate safety guard.
- **Fix A ⭐ Recommended**: Stand up a local Supabase for tests — `supabase start`, write the local URL/keys into `.env.test.local`, re-run `npm test` and confirm both suites go green.
  - Strength: Restores the guarantee the guard was protecting *and* the coverage it displaced; makes `supabase db reset` viable, which is exactly what the accepted lesson in `context/foundation/lessons.md:9` says a migration criterion requires.
  - Tradeoff: Requires Docker and a local stack the project has not needed until now; the migrations must apply cleanly from empty, which has never been exercised.
  - Confidence: MED — the test code is unchanged and passed against the remote project, but a from-empty `db reset` may surface ordering issues across the four migrations.
  - Blind spot: Whether `vitest.config.ts`'s `loadEnv` picks up `.env.test.local` at the right precedence has not been verified.
- **Fix B**: Run the suite with `ALLOW_REMOTE_TEST_DB=1` against the linked project.
  - Strength: One environment variable; restores green immediately with no new infrastructure.
  - Tradeoff: Re-enables exactly what the guard exists to prevent — creating and deleting real auth users with the service-role key in the live database. Papers over the gap rather than closing it.
  - Confidence: HIGH — this is the guard's own documented escape hatch.
  - Blind spot: None significant; the risk is the known one.
- **Decision**: FIXED via Fix B (fallback — Fix A blocked: no Docker/colima/podman on this machine, so `supabase start` cannot run). Added `"test:remote": "ALLOW_REMOTE_TEST_DB=1 vitest run"` to `package.json` as an explicit opt-in; the guard stays armed for the default `npm test`. Running it executes all three suites: **48 pass, 2 fail** — and those two failures are genuine, see F11. Fix A's blind spot resolved favourably: Vitest's default mode is `test`, so `loadEnv` gives `.env.test.local` precedence over `.env.local` as intended.

### F2 — A zero-row UPDATE reports "Company profile saved."

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/app/dashboard/company/actions.ts:48-65`
- **Detail**: The update checks only `error`. PostgREST returns 204 with `{ data: null, error: null }` when an UPDATE matches no rows — the repo already documents this exact behaviour at `tests/isolation.test.ts:220` (*"Silent denial: success, zero rows affected."*). If the owner's `companies` row is absent, the action reports success and `revalidatePath`s while nothing was written. A missing row is now an accepted degraded state: `20260730104501_handle_new_user_idempotent.sql` made provisioning `on conflict do nothing` on the stated grounds that *"provisioning is a convenience… it should degrade rather than block account creation."* The trigger is narrow (the page renders the defensive no-company message instead of the form when the row is missing), but the failure mode is the worst kind — the app tells the owner their data is saved when it is not.
- **Fix**: Add `.select('id')` to the update and treat an empty result as failure:
  `const { data, error } = await supabase.from('companies').update(validatedFields.data).eq('owner_id', user.id).select('id')` then `if (error || !data?.length) return { message: 'Could not save your company profile. Please try again.' }`.
- **Decision**: FIXED. `.select('id')` added with a comment explaining why it is load-bearing; the no-row case is a separate branch from the error case so the two log distinctly. Verified: `tsc` clean, `lint` clean, 50/50 tests.

### F3 — `authenticated` gets table-wide UPDATE and an unused INSERT on `companies`

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260729171332_company_profile.sql:77`
- **Detail**: `grant select, insert, update, delete on public.companies to authenticated;`. This **matches the plan verbatim** — the finding is against the plan's decision, not against the implementation. Two verbs survive `20260730104500_harden_company_delete.sql` (which revoked only `delete`):
  - **`insert`** is granted but no application path inserts; provisioning is trigger-only via `handle_new_user()`. An unused verb on the tenant anchor table.
  - **`update` is table-wide, not column-scoped.** `companies_update_own` (`20260726104601:41-45`) has `with check (owner_id = (select auth.uid()))`, which pins only `owner_id`. An owner holding nothing but their anon-key session can `PATCH /companies` and rewrite **`id`** and **`created_at`** on their own row. Self-inflicted today — but S-06's public form URL is keyed on the company id, and PRD FR-004 / the NFR require that identifier to be *unpredictable*. A self-chosen `id` (say, all-zeros) undermines that directly, and a rewritten `id` silently orphans future `company_id` FK references.
  This is the same class the project already accepted as F3 in the F-01 review; `insert` and the unscoped `update` were left behind.
- **Fix A ⭐ Recommended**: Forward-only compensating migration — `revoke insert, update on public.companies from authenticated;` then `grant update (name, industry, description, location) on public.companies to authenticated;`.
  - Strength: Column-level grants are the only mechanism that stops an `id`/`created_at` rewrite; RLS `with check` cannot express it. Follows the forward-only, compensating-migration pattern the two `20260730*` migrations already established.
  - Tradeoff: Column grants must be extended whenever a profile column is added, and forgetting that surfaces as a runtime `42501` rather than a compile error.
  - Confidence: HIGH — mirrors the shape of `20260730104500_harden_company_delete.sql` exactly.
  - Blind spot: Not verified whether the schema test's authenticated-owner UPDATE (`tests/schema.test.ts:144`) touches only the four granted columns; if it writes `updated_at` directly it would start failing.
- **Fix B**: Leave the grant, add an immutability trigger that raises when `new.id <> old.id or new.created_at <> old.created_at`.
  - Strength: One DDL object covering every future column without maintenance; enforces the invariant rather than the privilege.
  - Tradeoff: Runtime cost on every update and a second mechanism to reason about; leaves the unused `insert` grant untouched.
  - Confidence: MED — correct but heavier than the problem, and the project's existing precedent is to remove privilege, not to add guards.
  - Blind spot: Interaction with the `touch_updated_at` BEFORE UPDATE trigger's firing order.
- **Decision**: FIXED via Fix A. Added `supabase/migrations/20260730190000_narrow_company_write_grants.sql` (revoke `insert, update`; re-grant `update (name, industry, description, location)`), pushed to the linked project. `companies_insert_own` deliberately retained as the second layer. Fix A's blind spot checked and clear — every authenticated-owner UPDATE in the suite (`tests/schema.test.ts:147`, `tests/isolation.test.ts:288`) touches only the four granted columns; the trigger's write to `new.updated_at` is not privilege-checked because column grants apply to the statement's SET list, not to trigger modifications of NEW. Verified: 50/50 tests green after the push. One knock-on recorded honestly: `tests/isolation.test.ts:300` still asserts `42501` for the forged INSERT, but that code now arrives from the grant layer rather than the `with check` clause the case was written to prove — a comment at `:305-311` now says so rather than leaving the test looking like it proves more than it does.

### F4 — `deleteAccount` swallows the company read error, degrading the confirmation gate

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/app/dashboard/company/actions.ts:93-98`
- **Detail**: `const { data: company } = await supabase.from('companies').select('name').maybeSingle()` discards `error`. On any transient Supabase failure `company` is `undefined`, so `expected` silently falls back to `ACCOUNT_DELETION_FALLBACK_PHRASE` (`'DELETE'`, `validation.ts:99`) while the client still renders the real company name. The owner's correct input is then rejected with a confusing "Type DELETE exactly to confirm", and the type-to-confirm gate quietly degrades from a company-specific phrase to a generic word on the most destructive path in the app. Fails closed for the owner, so the security impact is bounded — but it defeats the gate's stated purpose. Also deviates from the sibling read path, which explicitly throws: `src/lib/dal.ts:45-47`.
- **Fix**: Destructure `error` and return `{ message: 'Could not verify your account. Please try again.' }` instead of falling through to the fallback phrase.
- **Decision**: FIXED. Destructured as `readError` (distinct from the later `deleteUser` error) and the action now fails closed before computing the phrase. Verified: `tsc` clean, `lint` clean, 50/50 tests.

### F5 — `createAdminClient()` leaves a refresh-token ticker per invocation

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/supabase/server.ts:46-51`
- **Detail**: The admin client is constructed with no `auth` options, so `autoRefreshToken` and `persistSession` both default to `true`. In `@supabase/auth-js`, the constructor's `initialize()` → `_handleVisibilityChange()` path does, for non-browser environments, *"in non-browser environments the refresh token ticker runs always"* → `startAutoRefresh()` → `setInterval`. Every `deleteAccount` request therefore leaves a live ticker on the warm serverless instance refreshing a session that does not exist (service-role clients have none). It is `unref()`'d so it will not hang the process, but the client and timer are retained per invocation. The tests get this right and the shared helper does not — `tests/isolation.test.ts:34` and `tests/schema.test.ts:35` both pass `{ auth: { autoRefreshToken: false, persistSession: false } }`. The file pre-dates this change, but `deleteAccount` is its first user-facing caller, so this slice is what makes it live.
- **Fix**: `createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })` — matching what both test files already do.
- **Decision**: FIXED. Options added to `createAdminClient()` with a comment on why a session-less client still starts a ticker. Verified: `tsc` clean, `lint` clean, 50/50 tests.

### F6 — Field errors are rendered but not programmatically associated or announced

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: `src/app/dashboard/company/company-profile-form.tsx:15-23`, `src/app/dashboard/company/delete-account-form.tsx:55-59`
- **Detail**: `FieldError` returns a bare `<p>` with no `id`, no `role="alert"`, no `aria-live`, and the paired `<input id="name" …>` (`:47`) carries no `aria-invalid` or `aria-describedby`. A screen-reader user who submits an invalid profile hears nothing on submit, and on tabbing back hears only "Company name, edit text". This matters more here than in a typical form because the component's own doc-comment (`:30-33`) records that HTML `required` was **deliberately omitted** so that server messages are the sole error channel — the channel that is inaudible. `delete-account-form.tsx:55-59` has the same gap on the destructive path and is inconsistent within its own file: the `state.message` paragraph immediately below (`:69-76`) does carry `aria-live="polite"`, the confirmation error carries nothing.
- **Fix A ⭐ Recommended**: Give each error an `id={`${name}-error`}`, add `role="alert"` to `FieldError`, and set `aria-invalid` + `aria-describedby` on each control; apply the same to the confirmation error.
  - Strength: Standard, self-contained; no new dependency, no change to the server contract, and it fixes the delete path's internal inconsistency at the same time.
  - Tradeoff: Touches four inputs plus the shared `FieldError`; `FieldError` currently takes only `messages`, so it needs a second prop.
  - Confidence: HIGH — conventional pattern, and `state.errors` already keys by field name.
  - Blind spot: `role="alert"` on a conditionally mounted node announces reliably in practice, but this has not been tested with an actual screen reader.
- **Fix B**: Add the ARIA wiring *and* move focus to the first invalid field after a failed submit.
  - Strength: A keyboard user is put where the problem is instead of having to hunt back up the form.
  - Tradeoff: Needs refs plus an effect keyed on `state`, and focus management on `useActionState` re-renders is easy to get subtly wrong.
  - Confidence: MED — correct in principle; the interaction with React's transition-driven re-render has not been verified here.
  - Blind spot: Whether the focus effect re-fires on an unchanged error state.
- **Decision**: FIXED via Fix A. `FieldError` now takes an `id` and renders `role="alert"`; all four profile controls carry `aria-invalid` + `aria-describedby`, and the description control keeps its hint in the description list (`'description-hint description-error'`) so the hint is not replaced by the error. The delete form's confirmation error got the same treatment, closing the inconsistency with the `aria-live` message directly below it. Verified: `tsc` clean, `lint` clean, `build` clean. Fix A's stated blind spot stands — not exercised with a real screen reader.

### F7 — Zod ships to the client bundle to support a 3-line string helper

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: `src/app/dashboard/company/delete-account-form.tsx:5`
- **Detail**: `'use client'` + `import { accountDeletionPhrase } from '@/lib/validation'` — a value import. `src/lib/validation.ts:1` imports `zod` and evaluates `LoginSchema` and `CompanyProfileSchema` at module scope; bundlers cannot prove `z.object({...})` is side-effect-free, so those initializers are retained and zod is pulled into the client bundle. (`company-profile-form.tsx:5` is safe — its import is type-only and erased.) This is the cost of a placement drift: the plan put the sentinel logic in the form, and the implementation hoisted it into `validation.ts` — a genuine improvement for the single-source-of-truth property the doc-comment at `validation.ts:101-107` is protecting, but it landed in a zod-importing module.
- **Fix**: Move `ACCOUNT_DELETION_FALLBACK_PHRASE` + `accountDeletionPhrase` into a zod-free module (e.g. `src/lib/account-deletion.ts`) imported by both the form and the action, preserving the shared-definition property.
- **Decision**: FIXED. Created `src/lib/account-deletion.ts`; `delete-account-form.tsx` and `actions.ts` both import from it, so the single-definition property is preserved. Verified: `tsc`/`lint`/`build` clean, 50/50 tests.

### F8 — `tests/validation.test.ts` uses a deep relative import into `src/`

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `tests/validation.test.ts:6`
- **Detail**: `import { CompanyProfileSchema, isCompanyProfileComplete } from '../src/lib/validation'` violates AGENTS.md (*"Import from `src/` with the `@/*` alias, not deep relative paths"*). Every source file in this change obeys the rule; this is the only violation. Root cause: `vitest.config.ts` defines no `resolve.alias`, and Vite does not read `tsconfig.json` `paths`.
- **Fix**: Add `resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }` to `vitest.config.ts`, then switch the import to `@/lib/validation`.
- **Decision**: FIXED. Alias added to `vitest.config.ts` with a comment on why Vite needs it; `tests/validation.test.ts:6` now imports `@/lib/validation`. Verified: 50/50 tests still resolve and pass.

### F9 — Untyped Supabase client makes `getCompany()` return `any`

- **Severity**: 💭 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: `src/lib/dal.ts:40-47`
- **Detail**: `createClient()` is instantiated without a `Database` generic and no generated Supabase types exist anywhere in `src/`. `supabase.from('companies').select(…)` therefore yields `data: any`, so `getCompany()` returns `any`. That `any` flows straight into `isCompanyProfileComplete(company)` (`src/app/dashboard/page.tsx:18`) and `<CompanyProfileForm company={company} />` (`src/app/dashboard/company/page.tsx:36`) — the `CompanyProfile` prop type at `company-profile-form.tsx:9` is checked against nothing. A typo'd column in the `select()` list type-checks and fails only at runtime. `tsc --noEmit` passes, but strict mode is buying less at this boundary than it appears to.
- **Fix**: `supabase gen types typescript > src/lib/supabase/database.types.ts` and parameterize `createClient<Database>()` and `createAdminClient<Database>()`.
  - Strength: Turns the DAL's column list into a compile-time contract; the widened `select` in this very change is exactly the kind of edit it would have checked.
  - Tradeoff: Adds a generated file that must be regenerated on every migration, and typing the clients may surface errors in existing call sites.
  - Confidence: MED — standard Supabase practice, but generation currently depends on reaching the linked project (or a local stack, see F1).
  - Blind spot: Whether the generated types cover `auth.admin` usage in `deleteAccount` without friction.
- **Decision**: FIXED. Generated `src/lib/supabase/database.types.ts` from the linked project and parameterized all three clients — `createServerClient<Database>`, `createSupabaseClient<Database>` (admin), and `createBrowserClient<Database>` in `client.ts`, which was outside the stated fix but would otherwise have been the last untyped one. The blind spot resolved clean: `auth.admin` needed no adjustment and no existing call site broke. **Verified that the fix bites**: temporarily misspelling a column in `getCompany()`'s select produced `SelectQueryError<"column 'industrry' does not exist on 'companies'.">` and five compile errors across both dashboard pages, then reverted. Regeneration after each migration is now a standing requirement, noted in a comment at `src/lib/supabase/server.ts`.

### F10 — No error boundary under `/dashboard`

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/app/dashboard/company/page.tsx:14`
- **Detail**: `getCompany()` throws on any Supabase error (`src/lib/dal.ts:46`) and there is no `error.tsx` anywhere under `src/app/`. A transient DB error renders the framework's generic 500 on both `/dashboard` and `/dashboard/company` rather than a recoverable state. Pre-existing pattern inherited from `/dashboard`, but this change adds a second route with the same exposure.
- **Fix**: Add `src/app/dashboard/error.tsx` with a retry affordance.
- **Decision**: FIXED. Added `src/app/dashboard/error.tsx`. Notable fork difference caught by reading `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md` rather than relying on the stock Next API: the retry prop is **`unstable_retry`** (added in v16.2.0), and the docs state `reset()` re-renders *without* re-fetching — which would have replayed the same failed read and made the retry button do nothing for exactly the transient-DB-error case this boundary exists for. The driver error message is logged, not rendered. Verified: `tsc`/`lint`/`build` clean.

### F11 — Two hardening migrations exist in the repo but were never applied to the live project

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260730104500_harden_company_delete.sql`, `supabase/migrations/20260730104501_handle_new_user_idempotent.sql`
- **Detail**: Discovered while applying F1's fix. `npx supabase migration list --linked` shows both `20260730104500` and `20260730104501` present locally with an **empty remote column** — never pushed. Consequences on the live database right now:
  - `companies_delete_own` and the `delete` grant are still in force, so an owner holding only their anon-key session can `DELETE /companies` and erase their own tenant row. Nothing re-creates it (`on_auth_user_created` fires only on `after insert on auth.users`, and no application code inserts a company), so the owner is permanently stuck on the "no company is provisioned" branch. This is precisely the bug the previous review's F3 was written to close.
  - `handle_new_user()` is still non-idempotent, so a replayed `auth.users` row aborts signup with an opaque `500: Database error saving new user`.
  This is also what makes `npm run test:remote` red: `tests/isolation.test.ts:266` and `:346` assert `error?.code === '42501'` for DELETE and get `undefined`, because the privilege is still granted remotely. **The tests are correct; the database is behind.** Note the second failing case actually deletes the throwaway owner's row as a side effect, since the operation genuinely succeeds.
- **Fix**: `npx supabase db push` to apply both migrations to the linked project, then re-run `npm run test:remote` and confirm 50/50 green.
- **Decision**: FIXED. `npx supabase db push --linked` applied both migrations on 2026-07-30; `npm run test:remote` is now **50/50 green (3 suites)**. (The CLI emitted a Docker warning about caching the migrations catalog — cosmetic, unrelated to whether the DDL applied; `migration list --linked` now shows both with a remote timestamp.)

## Notes on what was checked and found clean

- **The service-role delete path is correct.** No `formData`-sourced id, no hidden input, no query param anywhere in the id's provenance. `redirect()` outside try/catch, `scope: 'local'`, non-fatal sign-out.
- **No fake-passing tests.** Every denial in `tests/isolation.test.ts` pairs its `expect(error)` check with a service-role re-read (`readOwnerARow()`, `:201`) and `expect(after).toEqual(before)` — the silent-denial trap the plan called out is genuinely avoided. `tests/schema.test.ts:144` proves the GRANT behaviourally with an anon-key owner client, then re-reads to confirm the write landed.
- **Migration ordering is sound.** `20260729171332` → `20260730104500` → `20260730104501` apply in filename order; the later two are forward-only compensations and neither touches the profile columns, `touch_updated_at`, or its trigger. `touch_updated_at` is `BEFORE UPDATE` only, without `SECURITY DEFINER`, with `set search_path = ''` — `now()` resolves from the always-implicit `pg_catalog`.
- **No injection, no hardcoded secrets, no `dangerouslySetInnerHTML`, no N+1, no unbounded iteration.** Per-company isolation holds on every new query.
- **Minor, not raised as findings**: `error.flatten()` is `@deprecated` in the installed zod v4 in favour of `z.treeifyError()` — pre-existing and consistent across both actions, so changing one alone would be worse. Both new forms conditionally mount their `aria-live` paragraph, matching `login-form.tsx:42`; that is a project-wide pattern, not a regression. `tests/schema.test.ts:21-72` duplicates ~45 lines of setup from `tests/isolation.test.ts:20-78`, and `tests/support/` already exists as the extraction point.
