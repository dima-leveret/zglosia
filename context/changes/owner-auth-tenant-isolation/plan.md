# Owner Auth (Magic Link) + Per-Company Tenant Isolation — Implementation Plan

## Overview

Foundation slice **F-01**. Deliver the minimal end-to-end that proves ZGŁOSIA's core security guarantee: an owner signs in passwordless via Supabase magic link, a single isolated `companies` tenant exists for them (auto-provisioned), and per-owner data isolation is enforced by Postgres **Row Level Security (RLS)** keyed on `auth.uid()`. The isolation pattern established here — a `companies` table with `owner_id`, a reusable `current_company_id()` helper, RLS-via-user-session, and versioned SQL migrations — is the **contract inherited by all downstream slices** (S-01, S-02, S-03, S-04, S-06). Scope is deliberately narrow: owner identity + company record + isolation policy + an executable proof. Not the whole data layer.

## Current State Analysis

- **Stack:** Next.js 16.2.9 (modified fork with breaking changes), React 19.2.4, App Router, Tailwind v4, TypeScript `strict`. Import alias `@/*` → `src/*` (`tsconfig.json:22`).
- **Supabase SDK partially wired:**
  - `src/lib/supabase/client.ts:1` — browser client via `createBrowserClient` (`@supabase/ssr`), reads `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
  - `src/lib/supabase/server.ts:1` — **only** a service-role admin client (`createClient` from `@supabase/supabase-js`) that **bypasses RLS**. **There is no cookie-based SSR server client bound to the user session** — this is the central gap, and it is exactly what RLS isolation depends on.
- **No auth surface yet:** no `proxy.ts`, no `/login`, no `/auth/confirm`, no DAL, no protected routes. `src/app/page.tsx` is still the default Next.js template.
- **No database schema:** no `supabase/` directory, no migrations, no tables, no RLS.
- **No test runner** (AGENTS.md: "wire one up before adding tests").
- **Env ready:** `.env.local` holds all three keys (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Deps installed: `@supabase/ssr@^0.12.0`, `@supabase/supabase-js@^2.108.2`.

### Key Discoveries:

- **This fork renamed `middleware.ts` → `proxy.ts`** (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:11`), function named `proxy`, **Node.js runtime by default** (the `runtime` config option throws if set). The Supabase session-refresh loop must live in `proxy.ts` at the same level as `src/app` (i.e. `src/proxy.ts`).
- **Server Actions bypass proxy matcher exclusions** (`proxy.md:217`–219; `authentication.md:1449`): a Server Action is a POST to the route it lives on, so a proxy matcher that skips a path also skips its Server Actions. **Isolation/auth must be enforced at the data source (DAL + RLS), never on proxy alone.** Proxy is optimistic-only.
- **DAL pattern** (`authentication.md:1129`–1231): centralize auth in a `verifySession()` memoized with React `cache`, call it before every data request. This is the mandated Next.js pattern and where our RLS-scoped reads live.
- `cookies()` is async in this fork (`await cookies()`).

## Desired End State

An owner can visit the app, enter their email at `/login`, click the emailed magic link, and land on a protected `/dashboard` that displays **their own company row** — fetched through an RLS-scoped session client, proving the session and isolation both work. A second owner signing in sees only their own company. An automated Vitest test asserts owner B **cannot** read owner A's company. The schema and every RLS policy live as committed SQL under `supabase/migrations/`.

**Verification of end state:** `npm run build` + `npm run lint` clean; `npm test` green (2-tenant isolation test passes); manual magic-link login lands on `/dashboard` showing the correct company; logged-out access to `/dashboard` redirects to `/login`.

### Key Decisions (all confirmed during planning):

| Area | Decision |
| --- | --- |
| Tenancy model | `companies` table, `owner_id → auth.users(id)`, `UNIQUE(owner_id)` (flat 1 account = 1 company); downstream tables carry `company_id` FK. |
| Isolation enforcement | RLS policies (`auth.uid()`) via a cookie-based **user-session** client; service-role client reserved for privileged/test-only ops. |
| Schema source of truth | Supabase CLI migrations (`supabase/migrations/*.sql`), versioned and reviewed. |
| Downstream RLS primitive | `public.current_company_id()` SECURITY DEFINER helper → downstream policy is `company_id = public.current_company_id()`. |
| Company provisioning | DB trigger on `auth.users` insert auto-creates one `companies` row. |
| Magic-link completion | Emailed link → `/auth/confirm` route handler runs `verifyOtp(token_hash)` and sets the session cookie. |
| Input validation | Zod schema in the Server Action. |
| Auth surface | Minimal protected `/dashboard` placeholder reading the company via DAL; unauth → `/login`. |
| Root routing | Replace default template; `/` smart-redirects (authed → `/dashboard`, else → `/login`). |
| Verification | Vitest + a two-tenant RLS integration test. |
| Priority | RLS isolation is the non-negotiable core; UI polish may slip. |

## What We're NOT Doing

- **Company profile CRUD** (view/edit/delete company info, FR-002/FR-003) — that is **S-01 `company-profile`**. F-01 only ensures the company *row exists and is isolated*.
- **Any real landing/marketing content at `/`** — not in any PRD FR; `/` is a redirect only.
- **Submissions or plans tables** (S-02/S-03) — downstream slices append their own migrations using this slice's pattern.
- **Public form / QR** (S-05/S-06), roles/teams, password login, account deletion UX.
- **Rich dashboard shell** (nav, stubbed sections) — the placeholder is intentionally bare.

## Implementation Approach

Bottom-up so isolation is provable as early as possible: **(1)** land the database foundation (table, RLS, helper, provisioning trigger) as a committed migration and sanity-check it at the SQL layer; **(2)** close the missing-server-client gap and add the proxy + DAL so the app can hold an RLS-scoped session; **(3)** build the thin magic-link auth flow and the `/dashboard` proof page; **(4)** lock the isolation guarantee behind an automated two-tenant test. Each phase is independently verifiable; the security-critical work (Phase 1 + 4) brackets the flow.

## Critical Implementation Details

- **Supabase SSR proxy ordering (load-bearing):** in `proxy.ts`, create the server client, then call `supabase.auth.getUser()` **with no logic between them**, and **return the same `NextResponse` the client wrote cookies onto** — otherwise the refreshed session cookie is dropped and users get logged out intermittently. Use `getUser()` (revalidates against Supabase), never `getSession()`, for any trust decision.
- **SECURITY DEFINER hygiene:** `current_company_id()` and the provisioning trigger function run as definer to intentionally bypass RLS; each must set an explicit `search_path` (e.g. `set search_path = ''` with fully-qualified names, or `= public`) and be owned by the migration superuser. `execute` on the helper is granted to `authenticated`. Getting this wrong is a privilege bug, so it is authored once here and reused.
- **Magic-link email template is a manual Supabase config step:** the default template must be pointed at the `token_hash` confirm URL (`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`) for the server-side `/auth/confirm` flow to work. Captured in Migration Notes and as a manual verification item.

---

## Phase 1: Database Foundation (schema, RLS, helper, provisioning)

### Overview

Introduce Supabase CLI migrations as the schema source of truth and land the first migration: the `companies` table, RLS policies, the reusable `current_company_id()` helper, and the auto-provisioning trigger. This is the isolation contract every downstream slice inherits.

### Changes Required:

#### 1. Supabase project config + migrations scaffold

**File**: `supabase/config.toml`, `supabase/migrations/0001_owner_auth_tenant_isolation.sql`

**Intent**: Initialize the Supabase CLI project (`supabase init`) so schema lives in-repo and is reproducible via `supabase db reset` / `supabase migration up`. All subsequent slices append migrations here.

**Contract**: A `supabase/` directory committed to the repo with `config.toml` and a numbered migration file. Local project id/keys unchanged (uses existing `.env.local`).

#### 2. `companies` table + RLS policies

**File**: `supabase/migrations/0001_owner_auth_tenant_isolation.sql`

**Intent**: Create the tenant table with a 1:1 owner mapping and enable RLS so an owner can only touch their own row. This is the concrete record the isolation NFR is proven on.

**Contract**: `public.companies` with columns `id uuid pk default gen_random_uuid()`, `owner_id uuid not null references auth.users(id) on delete cascade`, `unique(owner_id)`, `name text`, `created_at timestamptz default now()`, `updated_at timestamptz default now()`. RLS enabled; four policies (select/insert/update/delete) all predicated on `owner_id = auth.uid()`. Grant table privileges to `authenticated`.

#### 3. Reusable isolation helper

**File**: `supabase/migrations/0001_owner_auth_tenant_isolation.sql`

**Intent**: Provide the single primitive downstream tables' policies will use (`company_id = public.current_company_id()`), so isolation is authored and tested once.

**Contract**: SECURITY DEFINER SQL function returning the caller's company id.

```sql
create function public.current_company_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$ select id from public.companies where owner_id = auth.uid() $$;

grant execute on function public.current_company_id() to authenticated;
```

#### 4. Auto-provisioning trigger

**File**: `supabase/migrations/0001_owner_auth_tenant_isolation.sql`

**Intent**: Guarantee the tenant exists the moment an account does — enforced in the DB so no app path can forget it.

**Contract**: A SECURITY DEFINER trigger function that inserts one `companies` row for each new `auth.users` row, wired as an `after insert` trigger.

```sql
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$ begin
  insert into public.companies (owner_id) values (new.id);
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

### Success Criteria:

#### Automated Verification:

- [ ] Migration applies cleanly from scratch: `supabase db reset`
- [ ] SQL-level RLS assertion passes: impersonating owner B (`set request.jwt.claims`) cannot `select` owner A's company row (run via `supabase db` psql or a checked-in `.sql` assertion script)
- [ ] Lint passes: `npm run lint`

#### Manual Verification:

- [ ] Creating a new auth user (Supabase dashboard → Auth) auto-creates exactly one `companies` row with matching `owner_id`
- [ ] `select public.current_company_id()` returns the caller's company id when impersonating that user, and `null`/empty for a user with no company

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: Auth Session Plumbing (server client, proxy, DAL)

### Overview

Close the missing-server-client gap and give the app a way to hold and refresh an RLS-scoped session: a cookie-based SSR server client, the `proxy.ts` session-refresh loop with optimistic route protection, and a DAL that is the single guarded data path.

### Changes Required:

#### 1. Cookie-based SSR server client

**File**: `src/lib/supabase/server.ts`

**Intent**: Add the user-session server client (bound to request cookies) alongside the existing admin client, so server components / actions / route handlers query Postgres **as the logged-in user** and RLS applies. The admin client stays for privileged/test-only use.

**Contract**: New async export `createClient()` using `createServerClient` from `@supabase/ssr` with `NEXT_PUBLIC_SUPABASE_ANON_KEY` and the `getAll`/`setAll` cookie adapter over `await cookies()` from `next/headers`. Existing `createAdminClient()` unchanged.

#### 2. Proxy session refresh + optimistic protection

**File**: `src/proxy.ts` (this fork's renamed middleware — sits beside `src/app`)

**Intent**: Refresh the Supabase session on every matched request and redirect unauthenticated users away from protected routes (optimistic pre-filter; not the security boundary).

**Contract**: Exports `proxy(request: NextRequest)` and a `config.matcher` excluding `_next/static`, `_next/image`, `favicon.ico`, and image assets. Creates the server client over request/response cookies, calls `getUser()`, and redirects: unauthenticated + protected path (`/dashboard`) → `/login`. Must return the response object carrying refreshed cookies (see Critical Implementation Details). Node runtime (no `runtime` override).

#### 3. Data Access Layer

**File**: `src/lib/dal.ts`

**Intent**: Centralize the auth check and the RLS-scoped company read so every consumer inherits the guarantee (the pattern the auth docs mandate, since Server Actions bypass proxy).

**Contract**: `'server-only'` module exporting `verifySession()` (React `cache`-memoized; `createClient()` → `getUser()`; `redirect('/login')` if absent; returns the user) and `getCompany()` (calls `verifySession`, then `select * from companies` — RLS scopes it to the owner — returns the single row). Selects only needed columns.

### Success Criteria:

#### Automated Verification:

- [ ] Type check passes: `npx tsc --noEmit`
- [ ] Production build passes: `npm run build`
- [ ] Lint passes: `npm run lint`

#### Manual Verification:

- [ ] Requesting `/dashboard` while logged out redirects to `/login` (proxy optimistic check)
- [ ] `src/lib/supabase/server.ts` exposes both `createClient()` (session) and `createAdminClient()` (service role) with no runtime import errors

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 3.

---

## Phase 3: Owner Auth Flow + Surface

### Overview

The thin passwordless flow and the proof surface: request a magic link, complete it server-side, land on a protected `/dashboard` that renders the owner's company via the DAL, plus logout and the smart-redirect root.

### Changes Required:

#### 1. Email validation schema

**File**: `src/lib/validation.ts` (or `src/app/login/schema.ts`)

**Intent**: Establish the reusable Zod validation pattern later forms inherit.

**Contract**: Add `zod` dependency; export a `LoginSchema` validating a trimmed, well-formed email, plus the `FormState` type used by `useActionState`.

#### 2. Login page + form

**File**: `src/app/login/page.tsx`, `src/app/login/login-form.tsx`

**Intent**: Collect the owner's email and trigger the magic-link Server Action, showing pending + validation/confirmation states.

**Contract**: Server page renders the client `login-form.tsx` (`'use client'`) using `useActionState(sendMagicLink, undefined)`; renders field errors and a "check your email" confirmation.

#### 3. Magic-link Server Action

**File**: `src/app/login/actions.ts`

**Intent**: Validate the email and ask Supabase to send the magic link pointed at our confirm route.

**Contract**: `'use server'` action: Zod-parse email (return field errors on failure), then `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: '<origin>/auth/confirm' } })`; returns a state object (success message or error). Uses the session server client.

#### 4. Confirm route handler

**File**: `src/app/auth/confirm/route.ts`

**Intent**: Complete the magic link server-side, setting the session cookie, then send the owner to the dashboard.

**Contract**: `GET` handler reads `token_hash` + `type` from the query, calls `supabase.auth.verifyOtp({ type, token_hash })`; on success `redirect` to `next ?? '/dashboard'`, on failure `redirect('/login?error=...')`.

#### 5. Protected dashboard placeholder (isolation proof surface)

**File**: `src/app/dashboard/page.tsx`

**Intent**: The smallest authenticated surface that demonstrates session + RLS end-to-end.

**Contract**: Server component calls `getCompany()` from the DAL and renders the company id/name (or an empty-name prompt). Includes the logout control. Unauth access already redirected by proxy + `verifySession`.

#### 6. Logout action

**File**: `src/app/dashboard/actions.ts` (or shared `src/lib/auth-actions.ts`)

**Intent**: End the session and return to login.

**Contract**: `'use server'` action: `supabase.auth.signOut()` then `redirect('/login')`. Rendered as a submit button in the dashboard.

#### 7. Smart-redirect root

**File**: `src/app/page.tsx`

**Intent**: Replace the leftover default template so `/` routes based on auth state.

**Contract**: Server component (or proxy rule) that redirects authed → `/dashboard`, otherwise → `/login`. Default Next.js template content removed.

### Success Criteria:

#### Automated Verification:

- [ ] Build passes: `npm run build`
- [ ] Lint passes: `npm run lint`
- [ ] Invalid-email input to the Server Action returns a Zod field error (unit-checkable once Vitest lands in Phase 4; otherwise manual)

#### Manual Verification:

- [ ] Full magic-link login: enter email at `/login` → receive email → click link → land on `/dashboard` showing the owner's company
- [ ] `/dashboard` displays the correct company row (proves session + RLS on the happy path)
- [ ] Logout returns to `/login`, after which `/dashboard` again redirects to `/login`
- [ ] `/` redirects logged-out visitors to `/login` and logged-in owners to `/dashboard`

**Implementation Note**: The magic-link email template must be configured in the Supabase dashboard first (see Migration Notes). After automated verification passes, pause for manual confirmation before Phase 4.

---

## Phase 4: Isolation Verification Harness

### Overview

Wire up a test runner and lock the isolation guarantee behind an automated two-tenant test — the executable guard downstream slices rely on so an RLS regression can't silently reopen the leak.

### Changes Required:

#### 1. Test runner setup

**File**: `vitest.config.ts`, `package.json`

**Intent**: Introduce Vitest (none configured yet) as the project's test runner.

**Contract**: Add `vitest` (+ needed types) dev deps; `vitest.config.ts`; `"test": "vitest run"` and `"test:watch": "vitest"` scripts. Test env loads Supabase keys from `.env.local`/`.env.test`.

#### 2. Two-tenant isolation test

**File**: `tests/isolation.test.ts`

**Intent**: Prove owner B cannot read owner A's company, and each owner sees exactly their own auto-provisioned row.

**Contract**: Using the service-role admin client, create two confirmed users (A, B); obtain an RLS-scoped session client for each (sign in); assert (a) each owner's `select from companies` returns exactly their own row (trigger provisioned it), (b) owner B querying owner A's company id returns empty. Tears down the test users in `afterAll`. Runs against a local `supabase start` instance or the configured project.

### Success Criteria:

#### Automated Verification:

- [ ] `npm test` passes: the two-tenant isolation test is green
- [ ] Test asserts both directions: own-row visible AND cross-tenant read denied

#### Manual Verification:

- [ ] Negative control: temporarily dropping the `companies` RLS SELECT policy makes the cross-tenant assertion **fail** (confirms the test actually exercises RLS), then restore

**Implementation Note**: After this phase, the slice is checkpoint-complete; commit and record SHAs in Progress.

---

## Testing Strategy

### Unit Tests:

- Zod `LoginSchema` rejects malformed emails / accepts valid ones (Phase 4 runner).

### Integration Tests:

- Two-tenant RLS isolation (Phase 4): own-row visibility + cross-tenant denial + trigger provisioning, against a real Supabase instance.

### Manual Testing Steps:

1. Configure the Supabase magic-link email template to the `/auth/confirm?token_hash=…&type=email` URL.
2. Sign in as owner A via magic link → confirm landing on `/dashboard` with A's company.
3. Sign in as owner B in a separate browser → confirm B sees only B's company.
4. Log out as B → confirm `/dashboard` redirects to `/login`.
5. Visit `/` logged out and logged in → confirm redirects.

## Performance Considerations

Negligible at MVP scale (low QPS, small data per shape-notes). Proxy runs on every matched request but only performs a cookie-based `getUser()` refresh (no DB round-trip beyond Supabase's own). `verifySession()`/`getCompany()` are `cache`-memoized per render pass to avoid duplicate calls.

## Migration Notes

- **Supabase email template (manual, one-time):** in the Supabase dashboard → Authentication → Email Templates → Magic Link, set the confirmation URL to `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` so the server-side `/auth/confirm` flow can call `verifyOtp`. Use `{{ .RedirectTo }}` (the `emailRedirectTo` the Server Action passes, derived from the request origin), **not** `{{ .SiteURL }}` — `.SiteURL` is pinned to the production origin, so a link requested from `localhost:3000` would still land on production. Note `{{ .TokenHash }}` is not `{{ .Token }}`; the latter is the 6-digit OTP and fails `verifyOtp`.
- **Site URL / redirect allow-list:** add the local (`http://localhost:3000/**`) and production (`https://zglosia.vercel.app/**`) origins to Supabase Auth → URL Configuration → Redirect URLs so `emailRedirectTo` is accepted. Without the entry, Supabase silently falls back to Site URL instead of erroring, so the symptom is landing on the wrong origin rather than a visible failure.
- **Transactional email provider:** custom SMTP via a personal Gmail account works for local verification but is not a production sender (≈500 recipients/day, throttling, spam placement) — swap to a transactional provider before deploy. The SMTP username must be the full email address; Gmail additionally requires an App Password, not the account password.
- Schema changes are forward-only migrations under `supabase/migrations/`; rollback = a new compensating migration (never edit an applied file).

## References

- Roadmap item: `context/foundation/roadmap.md` (F-01, lines 74–85)
- PRD: `context/foundation/prd.md` (FR-001, Access Control, NFR isolation/RODO)
- Shape notes (auth model): `context/foundation/shape-notes.md` (Access Control, FR-001)
- Fork docs — proxy convention: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
- Fork docs — auth/DAL pattern: `node_modules/next/dist/docs/01-app/02-guides/authentication.md`
- Existing clients: `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Database Foundation (schema, RLS, helper, provisioning)

#### Automated

- [x] 1.1 Migration applies cleanly from scratch: `supabase db reset` — 3fc56b2
- [x] 1.2 SQL-level RLS assertion passes: owner B cannot select owner A's company row — 3fc56b2
- [x] 1.3 Lint passes: `npm run lint` — 3fc56b2

#### Manual

- [x] 1.4 New auth user auto-creates exactly one companies row with matching owner_id — 3fc56b2
- [x] 1.5 `current_company_id()` returns the caller's company id (and null when none) — 3fc56b2

### Phase 2: Auth Session Plumbing (server client, proxy, DAL)

#### Automated

- [x] 2.1 Type check passes: `npx tsc --noEmit` — b51319a
- [x] 2.2 Production build passes: `npm run build` — b51319a
- [x] 2.3 Lint passes: `npm run lint` — b51319a

#### Manual

- [x] 2.4 Logged-out `/dashboard` request redirects to `/login` — b51319a
- [x] 2.5 server.ts exposes both createClient() (session) and createAdminClient() with no import errors — b51319a

### Phase 3: Owner Auth Flow + Surface

#### Automated

- [x] 3.1 Build passes: `npm run build` — a09cdf1
- [x] 3.2 Lint passes: `npm run lint` — a09cdf1
- [x] 3.3 Invalid-email input to the Server Action returns a Zod field error — a09cdf1

#### Manual

- [x] 3.4 Full magic-link login lands on `/dashboard` showing the owner's company — a09cdf1
- [x] 3.5 `/dashboard` displays the correct company row (session + RLS happy path) — a09cdf1
- [x] 3.6 Logout returns to `/login`; `/dashboard` then redirects to `/login` — a09cdf1
- [x] 3.7 `/` redirects logged-out → `/login`, logged-in → `/dashboard` — a09cdf1

### Phase 4: Isolation Verification Harness

#### Automated

- [x] 4.1 `npm test` passes: two-tenant isolation test is green — 276fcd6
- [x] 4.2 Test asserts both own-row visibility AND cross-tenant denial — 276fcd6

#### Manual

- [x] 4.3 Negative control: dropping the RLS SELECT policy makes the cross-tenant assertion fail, then restore — 276fcd6
