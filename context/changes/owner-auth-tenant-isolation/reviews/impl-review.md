<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Owner Auth (Magic Link) + Per-Company Tenant Isolation

- **Plan**: `context/changes/owner-auth-tenant-isolation/plan.md`
- **Scope**: Full plan — Phases 1–4 of 4 (all Progress checkboxes `[x]`)
- **Commit range**: `3fc56b2^..5165806`
- **Date**: 2026-07-30
- **Verdict**: REJECTED at review time (1 critical security finding — code was already merged, so this meant fix-forward before deploy)
- **Findings**: 1 critical, 8 warnings, 1 observation
- **Triage**: complete 2026-07-30 — 9 fixed, 1 recorded as a recurring rule, 0 skipped

## Triage outcome

| ID | Decision |
|---|---|
| F1 open redirect | FIXED |
| F2 Origin-derived `emailRedirectTo` | FIXED via Fix A |
| F3 owner can brick tenant | FIXED via Fix A |
| F4 proxy error handling | FIXED |
| F5 tests against hosted DB | FIXED |
| F6 non-idempotent trigger | FIXED |
| F7 missing table grants | ACCEPTED-AS-RULE (lesson recorded; code fix declined) |
| F8 missing `server-only` | FIXED |
| F9 untested write policies / 3.3 mis-filed | FIXED |
| F10 dead error paths | FIXED (both parts) |

### Open follow-ups (not doable from this session)

1. **Apply the two new migrations** — `20260730104500_harden_company_delete.sql` and `20260730104501_handle_new_user_idempotent.sql` are written but unapplied (`supabase db push`, or the dashboard SQL editor).
2. **Set `NEXT_PUBLIC_SITE_URL=https://zglosia.vercel.app`** in Vercel production env, or production magic links will point at `http://localhost:3000` (the fallback).
3. **Run the DB test suites against a local Supabase** — `supabase start` then `npm test`. The new forged-INSERT test and the two rewritten DELETE tests have never been executed; the F5 guard blocks them against the hosted project by design.
4. Verify the Supabase dashboard redirect allow-list matches the corrected `config.toml` entries.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

### Automated verification re-run (2026-07-30)

| Criterion | Result |
|---|---|
| 2.1 `npx tsc --noEmit` | PASS (exit 0, no output) |
| 1.3 / 2.3 / 3.2 `npm run lint` | PASS (eslint, no findings) |
| 2.2 / 3.1 `npm run build` | PASS (Next 16.2.9 Turbopack; 6 routes + proxy emitted) |
| 1.1 `supabase db reset` | NOT RUN — Docker daemon down; `.env.local` is linked to the hosted project, so a reset would wipe live data (see F5) |
| 4.1 / 4.2 `npm test` | NOT RUN — the suite creates/deletes real `auth.users` rows via the service-role key against the hosted project (see F5) |

### What was verified as correct (recorded so triage doesn't re-litigate)

- RLS verb coverage is complete: all four of select/insert/update/delete have policies, all scoped `to authenticated` (never `anon`/`public`), all keyed on `owner_id = (select auth.uid())`.
- `companies_insert_own` has a `with check` — an owner **cannot** forge a row with someone else's `owner_id`. `companies_update_own` has **both** `using` and `with check` — an owner cannot reassign `owner_id` to steal a tenant.
- Both `SECURITY DEFINER` functions set `search_path = ''` and schema-qualify every reference — no mutable-search_path escalation bug.
- The Supabase SSR proxy cookie contract is honored: zero logic between `createServerClient` and `getUser()`; `supabaseResponse` is the object returned; the redirect branch copies refreshed cookies forward.
- No `getSession()` anywhere; `redirect()` is never inside a try/catch; the service-role key is unreachable from any client bundle path in practice; `@/*` alias used consistently.
- No scope creep. The `Header.tsx` deletion and `layout.tsx` metadata edit are the correct completion of planned item 3.7 (removing the default template), not unplanned work.

## Findings

### F1 — Open redirect in the magic-link confirm route

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/app/auth/confirm/route.ts:16,23`
- **Detail**: `const next = searchParams.get('next') ?? '/dashboard'` then `NextResponse.redirect(new URL(next, request.url))`. `new URL(next, base)` discards the base for an absolute or protocol-relative value. Verified to escape the origin for `https://evil.com`, `//evil.com`, `/\evil.com`, `\/evil.com`, and `javascript:alert(1)`. Failure scenario: an attacker requests a magic link for their **own** address, then mails the victim `https://zglosia.app/auth/confirm?token_hash=<attacker token>&type=email&next=https://evil.com`. `verifyOtp` succeeds, the victim's browser now carries the **attacker's** session cookie (session fixation — every submission the victim enters lands in the attacker's tenant), and the victim is bounced off-site from a URL genuinely on the trusted domain. The plan literally specified `next ?? '/dashboard'`, so the implementation is faithful to a plan that was itself unsafe here.
- **Fix**: Never let `next` control the host — assign it to `.pathname` on a cloned `nextUrl` after a `startsWith('/') && !startsWith('//')` guard, falling back to `/dashboard`.
  - Strength: Matches Supabase's own confirm-route sample; removes the whole open-redirect class in ~3 lines at one call site.
  - Tradeoff: None meaningful.
  - Confidence: HIGH — behavior confirmed against the five payloads above.
  - Blind spot: None significant.
- **Decision**: FIXED — `safeNextPath()` guard added plus `.pathname` assignment on a cloned `nextUrl` (`src/app/auth/confirm/route.ts:6-16,29-34`). Blocks absolute, protocol-relative and backslash payloads; the host is no longer reachable from the query string. tsc + lint clean.

### F2 — `emailRedirectTo` is derived from the request `Origin` header

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/app/login/actions.ts:30,36`; `supabase/config.toml:159,163`
- **Detail**: `const origin = (await headers()).get('origin') ?? ''` feeds `emailRedirectTo: \`${origin}/auth/confirm\``. Next's Server Action CSRF check only requires `Origin` to *match* `Host`; it does not pin either to the real domain. The only thing preventing an attacker-chosen redirect host in a genuine Supabase email is Supabase's exact-match redirect allowlist — which lives entirely off-repo in dashboard settings. The committed config is not reassuring: `site_url = "http://127.0.0.1:3000"` and `additional_redirect_urls = ["https://127.0.0.1:3000"]` (note `https` on an `http` dev server — that entry matches nothing), with no production origin at all. Separately, when `Origin` is absent the `?? ''` fallback yields the relative `"/auth/confirm"`, which Supabase rejects or silently replaces with `site_url`.
- **Fix A ⭐ Recommended**: Build the redirect from a server-side constant — `process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'` — instead of the request header, and fix the `https://127.0.0.1:3000` typo plus add the deployed origin to `additional_redirect_urls`.
  - Strength: Removes request-controlled input from the auth-email path entirely; defense no longer depends on off-repo dashboard state.
  - Tradeoff: One more env var to set per environment (Vercel preview URLs need a wildcard or a per-deploy value).
  - Confidence: MEDIUM — the header path is definitely request-controlled; how exploitable it is in practice depends on whether Vercel's routing rejects a spoofed `Host` before the function runs, which was not tested.
  - Blind spot: The live dashboard allowlist was not inspected; manual criterion 3.4 passing implies it is configured correctly today.
- **Fix B**: Leave the origin derivation, fix only the `config.toml` allowlist entries.
  - Strength: Minimal edit; preview deployments keep working with no extra config.
  - Tradeoff: Account-takeover prevention stays wholly dependent on a setting nobody in the repo can review.
  - Confidence: MEDIUM.
  - Blind spot: Same as above.
- **Decision**: FIXED via Fix A — `SITE_URL` constant from `process.env.NEXT_PUBLIC_SITE_URL` replaces the `Origin` header (`src/app/login/actions.ts:6-13,36`); `headers()` import dropped. `supabase/config.toml` `site_url` → `http://localhost:3000` and `additional_redirect_urls` → localhost/127.0.0.1/`https://zglosia.vercel.app` wildcards. **Follow-up required**: set `NEXT_PUBLIC_SITE_URL=https://zglosia.vercel.app` in Vercel production env, or production magic links will point at localhost.

### F3 — An owner can permanently brick their own tenant; no re-provision, no backfill

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:47-50,96-98`; grant at `20260729171332_company_profile.sql:77`; dead-end UI at `src/app/dashboard/page.tsx:71-75`
- **Detail**: `on_auth_user_created` fires **only** `after insert on auth.users`; nothing else ever creates a `companies` row. Meanwhile `companies_delete_own` plus `grant delete … to authenticated` let any owner issue `DELETE /rest/v1/companies` through PostgREST with their own anon-key session and erase their tenant. There is no way back — the trigger won't re-fire and no app code inserts one. The user then sits on the "No company is provisioned for this account yet" branch forever. `tests/isolation.test.ts` ("lets owner A delete their own row") demonstrates exactly this state and treats it as a pass. No product feature requires `authenticated` DELETE: account deletion goes through `admin.auth.admin.deleteUser` and relies on `on delete cascade`. Separately, the migration provisions nothing for `auth.users` rows that already existed — it is not self-healing on a restore or import.
- **Fix A ⭐ Recommended**: Drop `companies_delete_own` and the `delete` grant in a compensating migration (least privilege — the cascade already covers erasure).
  - Strength: Removes the failure mode rather than papering over it; nothing in the product loses a capability.
  - Tradeoff: Requires updating the isolation test that currently asserts self-delete succeeds.
  - Confidence: HIGH — the only deletion path in the app is `deleteUser` + cascade (`src/app/dashboard/company/actions.ts:110`).
  - Blind spot: Whether a future slice wants owner-initiated company reset.
- **Fix B**: Keep DELETE, add an idempotent re-provision path (upsert in `getCompany()` or a "recreate company" action) plus a one-time backfill `insert … select from auth.users … on conflict do nothing`.
  - Strength: Self-healing regardless of how a row goes missing, including restores.
  - Tradeoff: Puts a write into the read path and keeps a privilege that serves no feature.
  - Confidence: MEDIUM.
  - Blind spot: Interaction with the RLS insert policy when the row is absent.
- **Decision**: FIXED via Fix A — new compensating migration `supabase/migrations/20260730104500_harden_company_delete.sql` drops `companies_delete_own` and revokes `delete` from `authenticated`. `tests/isolation.test.ts` updated: both DELETE tests now assert `42501` and that the row survives (owner A's self-delete flipped from a positive control to a denial). Residual: the *backfill* sub-issue is untouched, but with owner DELETE gone the "row goes missing" path is largely closed. **Follow-up required**: the migration has not been applied — run `supabase db push` (or apply via the dashboard) against the linked project.

### F4 — Proxy has no error handling; a Supabase blip 500s the entire site

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/proxy.ts:38-40`, matcher at `src/proxy.ts:70`
- **Detail**: `await supabase.auth.getUser()` is unguarded and the matcher covers essentially every route (`/`, `/login`, `/auth/confirm`, API, non-image assets). A network error, DNS failure, Supabase outage, or a missing `NEXT_PUBLIC_SUPABASE_URL` blowing the `!` assertion at line 16 makes the proxy throw, and **every request in the application fails** — including the unauthenticated `/login` page users would need to recover. The DAL is the real security boundary (the proxy is correctly documented as optimistic-only), so failing open on public routes costs nothing.
- **Fix**: Wrap the client creation + `getUser()` in try/catch; on failure return `supabaseResponse` for public routes and redirect to `/login` only for protected ones. Optionally narrow the matcher to `/dashboard/:path*`, `/`, `/login`.
  - Strength: Converts a total outage into degraded auth; the DAL still enforces isolation on every protected read.
  - Tradeoff: Slightly more branching in the proxy; must keep the cookie-passthrough contract intact inside the catch.
  - Confidence: HIGH — `verifySession()` is called in every server action and protected page, so nothing depends on the proxy for security.
  - Blind spot: None significant.
- **Decision**: FIXED — client creation + `getUser()` wrapped in try/catch (`src/proxy.ts:9-53`). `isProtected` is computed before the try (no logic inserted between `createServerClient` and `getUser()`); on failure public routes return `supabaseResponse` and protected routes fall through to the `/login` redirect with `user` null. tsc + lint + build clean.

### F5 — Test suite runs against the hosted project with the service-role key, with no environment guard

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `vitest.config.ts:15`; `tests/isolation.test.ts:18-32`
- **Detail**: `vitest.config.ts` loads `.env.local` — the same file `npm run dev` uses — and `.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at `https://xipt….supabase.co`, a hosted project, not `127.0.0.1:54321`. Confirmed during this review. So `npm test` on a developer machine creates and deletes real `auth.users` rows via the service-role key, and the later write-isolation suite issues an unfiltered `UPDATE … .neq('id','000…0')` plus `admin.from('companies').update(...)` — mutations that are only safe because RLS scopes them, on a live database. One `.env.local` pointed at production (the repo's current default state) and `npm test` is a data-loss event. This is why criteria 1.1 and 4.1 were not re-run during this review.
- **Fix**: Add a hard guard at the top of the test files — refuse to run unless the URL is `localhost`/`127.0.0.1` or `ALLOW_REMOTE_TEST_DB=1` is explicitly set — and load test env from a separate `.env.test.local`.
  - Strength: Makes the destructive case opt-in; costs ~5 lines and no workflow change for local Supabase users.
  - Tradeoff: Contributors must run `supabase start` (Docker) to run tests, which currently is not running on this machine.
  - Confidence: HIGH — target URL confirmed directly.
  - Blind spot: Whether CI is expected to run these tests against a shared project.
- **Decision**: FIXED — new `tests/support/require-local-db.ts` throws unless the target host is local or `ALLOW_REMOTE_TEST_DB=1`; called from `tests/isolation.test.ts` and `tests/schema.test.ts` (`validation.test.ts` is pure and unguarded). `vitest.config.ts` comment documents `.env.test.local` precedence over `.env.local`. Verified: `npm test` now refuses both DB suites by name and `validation.test.ts` (34 tests) passes. **Consequence**: `npm test` is red by default until a local Supabase is running — Progress criterion 4.1 ("npm test passes") no longer holds as written.

### F6 — `handle_new_user()` is not idempotent and hard-fails signup

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:81-98`
- **Detail**: `insert into public.companies (owner_id) values (new.id);` with no `on conflict` and no exception handling, while `owner_id` carries a `unique` constraint (line 17). Because it is an `after insert` trigger, *any* failure — a unique violation on a user re-import or a restore replaying `auth.users`, a missing grant, a future NOT NULL column — aborts the enclosing `auth.users` INSERT. The user-visible symptom is Supabase's opaque `500: Database error saving new user`, and signup is dead for **everyone** until someone reads Postgres logs.
- **Fix**: `insert into public.companies (owner_id) values (new.id) on conflict (owner_id) do nothing;` in a compensating migration (never edit the applied file).
  - Strength: One line; turns a fleet-wide signup outage into a no-op on the duplicate case.
  - Tradeoff: Hides the underlying anomaly rather than surfacing it — pair with a `raise warning` if you want visibility.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: FIXED — new migration `supabase/migrations/20260730104501_handle_new_user_idempotent.sql` does `create or replace` on the function body with `on conflict (owner_id) do nothing`. Trigger unchanged. Not yet applied.

### F7 — F-01 migration is not self-contained: no table GRANTs

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:15-50` (no table `grant` anywhere; only the function gets one, line 75)
- **Detail**: The plan's Phase 1 contract explicitly said "Grant table privileges to `authenticated`". The migration grants only on `current_company_id()`. `supabase/config.toml:19-24` documents that with `auto_expose_new_tables` unset, new entities are **not** auto-exposed — so on a fresh `supabase db reset` or a newly created project, every dashboard read fails with `42501: permission denied for table companies`. RLS decides *which rows*; grants decide *whether the verb is allowed at all*. This escaped notice only because the linked project predates the new default. The later slice found and fixed it (`20260729171332_company_profile.sql:77`, whose own comment admits the gap). The defect that stands against F-01 is reproducibility: the migration chain did not reconstruct a working environment from scratch at its own commit — and criterion 1.1 (`supabase db reset`) is checked off in Progress.
- **Fix**: Treat "grants ship in the migration that creates the object" as the standing rule, and run `supabase db reset` from an empty database before ticking a migration criterion. No code change needed — the gap is already closed downstream.
- **Decision**: ACCEPTED-AS-RULE: "Grants ship in the migration that creates the object" — appended to `context/foundation/lessons.md` (file created with the canonical header). Code fix declined: the gap is already closed by `20260729171332_company_profile.sql:77`.

### F8 — `server-only` guard missing on the module that exports the service-role client

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/lib/supabase/server.ts:1` (missing) vs `src/lib/dal.ts:1`
- **Detail**: `src/lib/dal.ts` opens with `import 'server-only'`. The module that actually exports `createAdminClient()` — the RLS-bypassing service-role client, the single highest-value thing in the repo to keep out of a client bundle — does not. Today an accidental client import would fail for incidental reasons (the `next/headers` import) and `SUPABASE_SERVICE_ROLE_KEY` would inline as `undefined` rather than leak, but that is luck, not design, and it evaporates if `createAdminClient` is ever split into its own file.
- **Fix**: Add `import 'server-only'` to the top of `src/lib/supabase/server.ts`.
- **Decision**: FIXED — `import 'server-only'` added with a comment naming what it protects (`src/lib/supabase/server.ts:1-6`). Build clean (Next resolves `server-only` internally; no dependency needed). `createAdminClient` left in place rather than split out.

### F9 — Success-criteria bookkeeping: write policies shipped untested, 3.3 filed as automated

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `context/changes/owner-auth-tenant-isolation/plan.md:397` (Progress 3.3); `tests/isolation.test.ts` @ `5165806`
- **Detail**: Three related bookkeeping gaps. (a) Progress 3.3 "Invalid-email input to the Server Action returns a Zod field error — a09cdf1" is filed under **Automated**, but a09cdf1 predates Vitest and no such test exists anywhere in the F-01 range; the plan's own Testing Strategy listed a `LoginSchema` unit test that was never written. (b) F-01's isolation suite is genuinely non-vacuous for reads — it re-reads both rows through the admin client to prove the empty result sets are RLS denial and not row absence, which is the right control — but `companies_insert_own`, `companies_update_own` and `companies_delete_own` were merged **completely unexercised**, on the slice whose entire purpose is the isolation contract. The later change closes most of this. (c) One gap survives even at HEAD: nothing attempts `insert({ owner_id: <other owner's id> })`, so the `with check` that blocks forging a row for another owner is never tested.
- **Fix**: Add the forged-INSERT test to `tests/isolation.test.ts`, and adopt "every policy a migration adds gets a test in the same slice" as a standing rule. Re-file 3.3 as manual in Progress.
- **Decision**: FIXED — added `denies owner B an INSERT that forges another owner_id` to `tests/isolation.test.ts`. It provisions a third user and clears the trigger-created row first, so `companies_insert_own`'s `with check` is the only thing that can refuse (asserting against owner A's id would risk 23505/23503 firing before the policy). Progress 3.3 moved from Automated to Manual in `plan.md` with a dated note. **Not executed** — blocked by the F5 guard until a local Supabase is available.

### F10 — Dead error paths: `?error=invalid_link` never rendered, `rls_isolation_check.sql` never run

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/app/auth/confirm/route.ts:31` vs `src/app/login/page.tsx:3-19`; `supabase/tests/rls_isolation_check.sql`
- **Detail**: Two dangling artifacts. (a) The confirm route redirects to `/login?error=invalid_link` but `LoginPage` takes no props and never reads `searchParams` — an owner whose magic link expired (`otp_expiry = 3600`) or was already used sees a blank sign-in form with no explanation, and will re-request into the `email_sent = 2`/hour rate limit (`config.toml:199`), producing a second dead end. (b) `supabase/tests/rls_isolation_check.sql` is logically sound but unrunnable and unrun: it needs a superuser `psql` connection, `npm test` only globs `tests/**/*.test.ts`, and `tests/schema.test.ts:11-13` states outright that psql is not installed and `SUPABASE_DB_URL` is set nowhere. It is fully superseded by the Vitest suite.
- **Fix**: Read `searchParams` in `LoginPage` and render "That sign-in link is invalid or has expired — request a new one"; delete `rls_isolation_check.sql` or wire it into a documented npm script.
- **Decision**: FIXED (both) — `LoginPage` is now async, awaits `searchParams` (Promise-typed per this fork's `page.md`), and renders a `role="alert"` message from a `CONFIRM_ERRORS` map. `supabase/tests/rls_isolation_check.sql` deleted via `git rm` (directory now empty and gone). Side effect: `/login` moves from static (○) to dynamic (ƒ) in the build output — expected, `searchParams` is a request-time API.

## Lower-priority notes (not tracked as findings)

- `current_company_id()` is `SECURITY DEFINER` but doesn't need to be — `companies_select_own` already lets a caller read their own row. The later migration states the opposite principle ("definer rights that aren't required are a liability") when declining definer for `touch_updated_at`. Inconsistent, not a bug.
- `handle_new_user()` gets no `revoke all … from public`, unlike `current_company_id()` (line 74). Not exploitable — Postgres refuses direct calls to `returns trigger` functions.
- `searchParams.get('type') as EmailOtpType | null` (`confirm/route.ts:15`) is an unchecked cast of user input in a `strict` repo. Not exploitable (Supabase validates server-side).
- `createAdminClient()` omits `auth: { autoRefreshToken: false, persistSession: false }`, which both test files set.
- Proxy calls `getUser()` on every matched request; `/` then calls it a second time for the same request.
- `src/app/dashboard/actions.ts:13` discards the `signOut()` error, while `deleteAccount` captures and logs the analogous error.
- The `/login` redirect in the proxy drops the requested path (no `?next=`), so deep links always land on `/dashboard` after sign-in. Depends on F1 being fixed first.
- Non-null `!` assertions on env vars with no startup validation, in a repo that already has Zod.
- `tests/isolation.test.ts:79-92`: if `beforeAll` throws partway through `createOwner`, the orphan user leaks into the target database.
- `supabase/config.toml:159-161` still carries `supabase init` defaults, so a local `supabase start` would reject the `emailRedirectTo` origin.
