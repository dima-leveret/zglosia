# Owner Auth (Magic Link) + Per-Company Tenant Isolation — Plan Brief

> Full plan: `context/changes/owner-auth-tenant-isolation/plan.md`

## What & Why

Foundation slice **F-01**: passwordless owner login (Supabase magic link) plus a single, isolated `companies` tenant whose per-owner isolation is enforced by Postgres RLS on `auth.uid()`. This exists to prove ZGŁOSIA's load-bearing security guarantee (FR-001, RODO NFR) once, in a reusable way — every downstream slice (S-01, S-02, S-03, S-04, S-06) inherits this isolation pattern instead of reinventing it.

## Starting Point

Supabase is half-wired: a browser client and a **service-role admin client that bypasses RLS** exist, but there is **no cookie-based session server client** — the exact thing RLS needs. No `proxy.ts`, no auth routes, no DAL, no database schema, no test runner. `src/app/page.tsx` is still the default Next.js template. All three Supabase keys are already in `.env.local`.

## Desired End State

An owner enters their email at `/login`, clicks the magic link, and lands on a protected `/dashboard` showing **their own company** — fetched through an RLS-scoped session client, proving session + isolation. A second owner sees only their own company, and an automated test asserts cross-tenant reads are denied. Schema and RLS live as committed SQL migrations.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Tenancy model | `companies.owner_id → auth.uid()`, `UNIQUE(owner_id)` | Matches flat "1 account = 1 company"; anchors RLS to native `auth.uid()` | Plan |
| Isolation enforcement | RLS via user-session client | DB enforces the boundary; a forgotten filter can't leak data | Plan |
| Schema source | Supabase CLI migrations | Versioned, reviewable RLS is essential when isolation is the product | Plan |
| Downstream RLS primitive | `current_company_id()` SECURITY DEFINER helper | One tested one-liner every future policy reuses | Plan |
| Provisioning | DB trigger on `auth.users` insert | Tenant always exists the instant an account does | Plan |
| Magic link | Email link → `/auth/confirm` `verifyOtp` | Standard `@supabase/ssr` server-side flow; one click | Plan |
| Validation | Zod | Reusable typed validation pattern for all later forms | Plan |
| Auth surface | Minimal protected `/dashboard` reading company via DAL | Smallest thing that demonstrates auth + isolation | Plan |
| Root `/` | Smart redirect (authed → dashboard, else login) | Auth routing needs it; no landing content is speced | Plan |
| Verification | Vitest + 2-tenant RLS test | Executable guard against future isolation regressions | Plan |

## Scope

**In scope:** magic-link login/logout, `/auth/confirm`, `companies` table + RLS + helper + provisioning trigger, session server client, `proxy.ts`, DAL, minimal `/dashboard` proof page, smart-redirect `/`, isolation test.

**Out of scope:** company profile CRUD (S-01), submissions/plans tables (S-02/S-03), public form + QR (S-05/S-06), real landing content, roles/teams, password login.

## Architecture / Approach

Postgres RLS is the security boundary; the Next.js app just carries an RLS-scoped Supabase session. Flow: `proxy.ts` refreshes the session + optimistically redirects → `/login` Server Action (Zod) sends the magic link → `/auth/confirm` route runs `verifyOtp` and sets the cookie → server components read data through a DAL (`verifySession` + `getCompany`) that queries **as the user**, so RLS applies. A DB trigger auto-provisions each owner's company; `current_company_id()` is the reusable primitive downstream policies key on.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Database Foundation | `companies` + RLS + helper + provisioning trigger as a committed migration | SECURITY DEFINER / `search_path` correctness |
| 2. Auth Session Plumbing | Session server client, `proxy.ts`, DAL | Supabase SSR cookie ordering (dropped-session bug) |
| 3. Auth Flow + Surface | `/login`, `/auth/confirm`, `/dashboard`, logout, smart `/` | Email template must be configured in Supabase dashboard |
| 4. Isolation Verification | Vitest + two-tenant RLS test | First-time test harness against real Supabase |

**Prerequisites:** a reachable Supabase project (keys already in `.env.local`); magic-link email template pointed at `/auth/confirm`.
**Estimated effort:** ~3–4 after-hours sessions.

## Open Risks & Assumptions

- Isolation test needs a real Supabase instance (local `supabase start` or the cloud project) — not a pure in-memory unit test.
- Magic-link deliverability + the email-template config are manual Supabase-side steps outside the code diff.
- `@supabase/ssr` proxy cookie handling is the classic footgun; the plan pins the exact ordering to avoid intermittent logouts.

## Success Criteria (Summary)

- Owner logs in via magic link and sees **their own** company on `/dashboard`; logged-out access redirects to `/login`.
- A second owner cannot see the first owner's company — asserted by an automated test.
- Schema + RLS are committed migrations; `npm run build`, `npm run lint`, and `npm test` are clean.
