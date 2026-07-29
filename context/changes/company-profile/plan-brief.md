# Company Profile — Plan Brief

> Full plan: `context/changes/company-profile/plan.md`

## What & Why

Roadmap slice **S-01**. The owner can enter, view, edit, and permanently erase their company data (FR-002, FR-003). The four fields are chosen as **structured context for S-03's action-plan prompt** — the PRD's Business Logic says company context enriches the generated plan, so shaping it now saves a second migration and a prompt rewrite during the north-star slice.

## Starting Point

F-01 already created `public.companies` with RLS keyed on `auth.uid()`, all four policies, a `current_company_id()` helper, and a trigger that auto-provisions **one blank row per new user**. `getCompany()` reads it; `/dashboard` renders `name` with a "Not set yet" fallback. Nothing in the codebase writes to the table — this slice introduces the first owner write path, which is why write isolation is currently unproven.

## Desired End State

An owner opens `/dashboard/company`, fills in name / industry / description / location, and saves with inline validation and a confirmation. The dashboard links there and flags an incomplete profile. A separate type-to-confirm control permanently deletes the account — the `auth.users` row goes, the company row follows via `ON DELETE CASCADE`, the session clears, and the owner lands on `/login`. Automated tests prove owner B can neither read, update, nor delete owner A's company.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Field set | name, industry, description, location | Each measurably sharpens an LLM plan; no contact/branding fields, which are inert for S-03. |
| Destructive semantics | Delete the auth user (cascades to company) | Deleting only the company row would orphan the tenant — `current_company_id()` goes NULL and the trigger only fires on user insert. |
| Delete confirmation | Type-to-confirm | Erasure is irreversible with no backup or export path in the MVP. |
| Required fields | All four, enforced in Zod | DB columns stay nullable because rows are auto-provisioned blank. |
| Surface location | `/dashboard/company` | Inherits the existing `/dashboard` prefix guard in `src/proxy.ts` with no config change. |
| Feedback | `useActionState` inline status | Reuses the login form's established pattern and the shared `FormState` type. |
| Schema gaps | Fix both in this migration | `updated_at` has no BEFORE UPDATE trigger, and the table has no explicit GRANTs — this slice is the first to need UPDATE. |
| Migration path | `supabase db push` to linked cloud | `.env.local` targets the cloud project and no local instance runs; `db reset` would wipe live data. |
| Testing | Extend the two-tenant harness to writes | Cross-tenant denial is silent (empty result, no error), so it must be asserted by re-reading the row. |
| Write path filter | `.eq('owner_id', user.id)` on the update | An over-matching SELECT leaks, but an over-matching UPDATE rewrites every visible row — the read path's filter-free convention does not extend to writes. |
| Sign-out on deletion | `signOut({ scope: 'local' })`, errors non-fatal | The default global scope calls the logout endpoint for a user that was just deleted; a failure there must not report "deletion failed" for an account that is already gone. |
| `FormState` | Made generic, `FormState<TFields>` | Widening one shared type would make every future form's field keys accumulate in it. |

## Scope

**In scope:** three new profile columns + `updated_at` trigger + explicit grants; Zod schema and completeness predicate; widened DAL read; `/dashboard/company` page, form, and update action; dashboard link and empty state; write-isolation and schema tests; type-to-confirm account deletion.

**Out of scope:** contact/branding fields and logo upload (would pull in Supabase Storage); forced onboarding gate; toast infrastructure; profile history or soft delete; submissions and plans tables (S-02/S-03); reworking `/dashboard` into a real shell.

## Architecture / Approach

One additive migration extends the existing tenant table. The write path runs entirely through the **RLS-scoped session client** with no explicit owner filter — Postgres does the scoping, exactly as F-01 established. The single exception is account deletion, which needs `createAdminClient()` (service role, bypasses RLS) because Supabase has no self-service user deletion on the anon key; there the user id comes strictly from `verifySession()` and never from the request. Every Server Action re-verifies the session, since Server Actions bypass the proxy matcher.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema migration | Three columns, `updated_at` trigger, explicit grants | Applied forward-only to the live cloud DB — no throwaway environment |
| 2. Validation + DAL contract | `CompanyProfileSchema`, completeness predicate, widened read, schema unit tests | Low; contract-only |
| 3. Profile surface | `/dashboard/company` page, form, update action, dashboard wiring | Server Action must re-verify auth — the proxy does not cover it |
| 4. Write-isolation verification | Cross-tenant UPDATE/DELETE denial against a live instance | Denial is silent; a weak assertion would pass with policies dropped |
| 5. Account deletion | Type-to-confirm erasure via guarded admin client | Service-role client in a user-facing path, and it is **not** reachable from the test suite — the session-derived-id rule is a code-review invariant |

**Prerequisites:** F-01 (`owner-auth-tenant-isolation`) is `implemented`; Supabase CLI linked to the project; `.env.local` populated.
**Estimated effort:** ~2–3 sessions across five phases; phases 1–2 are short, phase 3 carries the UI bulk, phase 5 needs the most care per line.

## Open Risks & Assumptions

- The migration lands on the live cloud database with no disposable replay target; it is additive only, but a mistake is not undone by `db reset`.
- Account deletion exceeds FR-003 as literally worded (delete company *info*), chosen deliberately because the flat 1-account-1-company model makes a row-only delete incoherent. Aligns with the RODO NFR.
- Deletion has no data-export path — worth revisiting as a RODO requirement before production.
- Explicit grants assume the linked project has not diverged from the F-01 schema by manual edits in Studio.
- Once S-02/S-03 land, the cascade will also take submissions and saved plans; that blast radius grows silently unless revisited.
- The `deleteAccount` Server Action has no automated regression guard — Vitest runs without a Next runtime, so the action is unreachable from the suite. Phase 4 covers the database half; the rest rests on code review.

## Success Criteria (Summary)

- An owner can fill in all four fields, save, reload, and see them persisted — with inline errors when a field is blank.
- The dashboard tells a new owner their profile is incomplete and links them to fix it.
- An owner can permanently erase their account behind a type-to-confirm gate and is returned to `/login` with nothing of theirs left in the database.
- `npm test` proves owner B cannot read, update, or delete owner A's company.
