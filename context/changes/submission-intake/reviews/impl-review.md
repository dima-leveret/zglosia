<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Submission Intake — Manual Add, List, Delete

- **Plan**: `context/changes/submission-intake/plan.md`
- **Scope**: Full plan — Phases 1–5 of 5
- **Date**: 2026-08-04
- **Verdict**: NEEDS ATTENTION → **APPROVED** after triage (9 of 10 findings fixed; F6 skipped by decision)
- **Findings**: 0 critical, 7 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Success criteria verification

All automated criteria re-run at review time:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `npm run lint` | PASS (clean) |
| `npm run build` | PASS (`/dashboard/submissions` registered dynamic) |
| `npm run test:remote` | PASS (72/72, 3 files) |
| `supabase migration list --linked` | PASS (`20260804171802` remote column populated) |

Progress: 38/39 rows ticked. The one open row, **1.2** (replay from empty via `supabase db reset`), is blocked by the absence of a container runtime and was deliberately never ticked, per `lessons.md`'s prohibition on ticking by inference. The four privilege-negative assertions in `tests/schema.test.ts` are the named compensating control and pass against the live database.

Manual rows were confirmed by the user at each phase gate. Rows 3.6 and 3.8 (form clears on success / preserves on failure) carry observable evidence in the diff — the `state.values` echo mechanism in `validation.ts:29-39` + `submission-form.tsx:50` — so they are not rubber-stamped. Row 2.5 was explicitly deferred to 5.4 and closed there.

## Findings

### F1 — `as` cast in getSubmissions defeats the compile-time column check its own comment promises

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/dal.ts:101
- **Detail**: `submissions: (data ?? []) as SubmissionListRow[]`. The doc comment at `dal.ts:61-65` states `SubmissionListRow` is derived from the generated schema "so dropping a column from the select below is a type error in the component instead of an undefined at runtime." The cast makes that claim false. Verified empirically at review time: (a) dropping `source` from the `.select()` while keeping the cast passes `tsc --noEmit` clean; (b) removing the cast alone also passes clean — supabase-js already infers the exact shape from the `Database` generic, so the cast buys nothing; (c) removing the cast *and* dropping the column produces `TS2322: Type '{ id, content, created_at }[]' is not assignable to type 'SubmissionListRow[]'` at `page.tsx:53`. The runtime consequence of (a) is not cosmetic: `source` would be `undefined`, `SourceBadge`'s `source === 'manual'` would be `false`, and every row would render the "From form" badge — silently inverting the FR-008 provenance marking this entire slice exists to guarantee. `getCompany` at `dal.ts:50` returns `data` uncast, so this also diverges from the sibling convention in the same file.
- **Fix**: Change to `submissions: data ?? []` and keep `SubmissionListRow` as the exported prop type.
  - Strength: Restores the compile-time link the comment promises; strictly removes code; matches `getCompany` in the same file.
  - Tradeoff: None — verified the cast is redundant.
  - Confidence: HIGH — all three behaviours confirmed by running `tsc` at review time.
  - Blind spot: None significant.
- **Decision**: FIXED — cast removed; `submissions: data ?? []`, with a comment recording why a cast here would be actively harmful.

### F2 — Content cap is enforced only in the application layer, bypassable via direct PostgREST

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260804171802_submission_intake.sql:46
- **Detail**: `content text not null` carries no `CHECK`. The 2000-character cap exists only in Zod (`validation.ts:55,108`) and in the textarea's `maxLength`. An owner holding the public anon key and their own JWT can `POST /rest/v1/submissions` with `{company_id: <their own>, content: <10 MB>, source: 'manual'}`: the column-scoped grant permits it and the RLS `with check` passes, since neither constrains length. Whitespace-only content is likewise accepted by Postgres while Zod rejects it. This matters because the cap is documented as "an S-03 prompt-token budget, not a cosmetic limit" — an unbounded row is a direct cost and latency vector on the plan-generation step, and a blank row is what `tests/validation.test.ts` describes as polluting the prompt. It is also the generalised form of this repo's own accepted lesson that DB-layer invariants belong in the DB. Note the plan never specified a check constraint, so this is a plan gap rather than implementation drift.
- **Fix A ⭐ Recommended**: Add a follow-up migration with `check (char_length(content) between 1 and 2000 and char_length(btrim(content)) > 0)`, plus a `tests/schema.test.ts` case asserting `23514` on over-long and whitespace-only inserts.
  - Strength: Puts the invariant where it cannot be bypassed, and S-06's anon insert path inherits it for free rather than needing its own guard.
  - Tradeoff: Couples the DB to a number that currently lives in `validation.ts`; the two must be changed together, and nothing enforces that pairing.
  - Confidence: HIGH — mechanism is standard and the bypass is straightforwardly reachable.
  - Blind spot: Whether 2000 is the right permanent bound, or whether S-03 will want to raise it once real prompt costs are measured.
- **Fix B**: Accept as-is and revisit when S-06 opens the anon insert path.
  - Strength: The only actor who can exploit this today is the owner harming their own tenant; no cross-tenant exposure.
  - Tradeoff: Leaves the guarantee resting on client-side code at exactly the moment an unauthenticated writer appears.
  - Confidence: MEDIUM — depends on S-06 remembering.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — migration 20260804183507_submission_content_bounds.sql, corrected by 20260804183633_fix_submission_blank_check.sql (btrim/1 trims spaces only, so tab/newline-only content survived it; the new test caught this on first run). Regex `content ~ '[^[:space:]]'` now matches .trim() semantics. Three schema tests added asserting 23514 and the 2000-char boundary. Both migrations applied remotely.

### F3 — No unfiltered cross-tenant DELETE test, the most dangerous shape on this table

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: tests/isolation.test.ts:467-488
- **Detail**: The submissions block tests a *targeted* cross-tenant delete (`.eq('id', ownerASubmissionId)`) but has no unfiltered equivalent. The companies suite's most valuable case is precisely the unfiltered one — "denies owner B an unfiltered UPDATE from reaching owner A's row" (`isolation.test.ts:229-253`) — including the companion assertion that owner B's *own* row did change, so a no-op statement cannot fake a pass. The asymmetry matters more here, not less: on `companies`, DELETE is revoked outright so any delete fails loudly with 42501, whereas on `submissions` DELETE is *granted*, so an over-matching delete is scoped by RLS alone and its denial is silent. An unfiltered delete is the one statement shape that could destroy another tenant's rows rather than merely leak them, and nothing currently pins it. The plan's Phase 5 contract listed only the targeted delete, so this is a plan gap.
- **Fix**: Add a case issuing `ownerB.db.from('submissions').delete().neq('id', '00000000-0000-0000-0000-000000000000').select('id')`; assert `error` is null and the returned array contains only B's own row ids; re-read owner A's row through the service-role client to prove it survived; and assert owner B's own row *was* removed so the test cannot pass vacuously.
  - Strength: Mirrors the existing companies-suite case exactly, including its anti-vacuity companion; covers the one shape granted DELETE makes reachable.
  - Tradeoff: The test destroys B's fixture row, so it must run after the cases that depend on it, or seed its own.
  - Confidence: HIGH — the pattern already exists in this file and can be copied.
  - Blind spot: None significant.
- **Decision**: FIXED — unfiltered cross-tenant DELETE case added, with the service-role re-read proving A survived and the anti-vacuity assertion that B's own row was removed.

### F4 — Zero-row delete leaves a phantom row on screen with no recovery

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/dashboard/submissions/actions.ts:159-165
- **Detail**: The zero-row branch returns `DELETE_FAILURE_MESSAGE` and returns *before* the `revalidatePath` calls at `:167-168`. When the row is genuinely already gone — deleted in another tab, or the page left open while it was removed elsewhere — the owner is told "Could not delete that submission. Please try again", the stale row stays rendered because nothing revalidated, and every retry reproduces the identical failure permanently. The `.select('id')` + non-empty-array discipline is correctly applied; it is the recovery path that is missing.
- **Fix**: Call both `revalidatePath` calls before returning in the zero-row branch so the list re-renders and the stale row disappears; keep the `console.error` for the operator.
  - Strength: Turns a permanent dead end into a self-correcting one, with a two-line change.
  - Tradeoff: Whether "already absent" should read as success rather than failure to the owner is a judgement call worth making explicitly.
  - Confidence: HIGH — the failure is deterministic and the fix is local.
  - Blind spot: None significant.
- **Decision**: FIXED — both revalidatePath calls now run in the zero-row branch before returning, so a stale row disappears instead of persisting under a permanent error.

### F5 — Armed-state announcement is unreliable and describes the wrong control

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/dashboard/submissions/submission-row.tsx:63-74,81
- **Detail**: Two compounding problems in the mechanism meant to satisfy the plan's "the armed state must be announced" requirement. First, `<p role="status">` is mounted at the same moment as its text; ARIA live regions must already exist in the DOM before their content changes, and a region inserted together with its content is skipped by several AT/browser pairs (notably VoiceOver/Safari). Second, `aria-describedby={\`delete-prompt-${id}\`}` sits on **Confirm** (`:74`) while focus is deliberately moved to **Cancel** (`:81`) — so the keyboard user who just armed the row lands on a control carrying no description at all. Net effect: a screen-reader user can arm a destructive control and hear nothing about it, which is the exact outcome the requirement was written to prevent.
- **Fix**: Render the `<p role="status">` unconditionally in the row (empty when disarmed, filled when armed) so the region pre-exists, and move `aria-describedby` onto Cancel — or onto the wrapping `<form>` so both buttons inherit it.
  - Strength: Fixes both halves with no structural change; the persistent-region pattern is the standard remedy.
  - Tradeoff: An always-present empty paragraph in every row.
  - Confidence: MED-HIGH — the live-region timing issue is well documented, though not verified against a specific screen reader here.
  - Blind spot: Not tested with an actual screen reader; AT behaviour varies.
- **Decision**: FIXED — role="status" is now rendered unconditionally so the live region pre-exists, and aria-describedby moved onto the wrapping form so Confirm and Cancel both inherit it.

### F6 — Submission dates render in the server's time zone, not the owner's

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/dashboard/submissions/submission-list.tsx:10-14
- **Detail**: The formatter pins the *locale* (`en-GB`) with a comment explaining that an implicit locale would make output depend on where it runs — then stops short of pinning `timeZone`, leaving exactly that dependence in place for the calendar day. With no `timeZone` option the day is derived from the server process's `TZ`: UTC on Vercel, Europe/Warsaw on the developer's machine. For a Polish-market product, a submission created at 01:30 Warsaw time renders as the previous day in production, and dev and prod disagree about the same row. This is a correctness bug in the rendered value, not a hydration issue — the date is server-rendered and passed down as children, which is correct.
- **Fix**: Add `timeZone: 'Europe/Warsaw'` to the `Intl.DateTimeFormat` options, completing the determinism the comment already commits to.
  - Strength: One line; makes dev and prod agree; matches the product's actual market.
  - Tradeoff: Hardcodes a single timezone, which is wrong the day the product serves owners outside Poland.
  - Confidence: HIGH — behaviour of `Intl.DateTimeFormat` without `timeZone` is unambiguous.
  - Blind spot: Whether a future multi-region product should instead render dates client-side from the ISO string.
- **Decision**: SKIPPED — dates continue to render in the server's time zone.

### F7 — `FormState<'submission'>` advertises an error key that can never be returned

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/app/dashboard/submissions/actions.ts:116-117
- **Detail**: `deleteSubmission` is typed `Promise<FormState<'submission'>>` but never returns an `errors` object on any path — only `message`. Declaring `'submission'` as a field name is precisely the drift the generic parameter was introduced to prevent; `validation.ts:20-25` states the rationale outright: "otherwise every form's keys accumulate in one shared type and the login form ends up advertising a `location` error it can never return." The plan specified this signature, so the implementation followed it faithfully — the defect is in the plan.
- **Fix**: Change both occurrences to `FormState<never>`.
  - Strength: Makes the type honest about the action's actual surface; one-line change in two places.
  - Tradeoff: Diverges from the literal plan text, which named `'submission'`.
  - Confidence: HIGH — the action's return paths are fully enumerable and none carry `errors`.
  - Blind spot: None significant.
- **Decision**: FIXED — both occurrences are now FormState<never>.

### F8 — Submissions page has no null-tenant branch, unlike both sibling pages

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/app/dashboard/submissions/page.tsx:14
- **Detail**: The page never checks whether a company row exists. With no company, `current_company_id()` returns NULL, RLS yields zero rows, and the owner sees the friendly "No submissions yet" empty state plus a working-looking form that then fails with the generic "Could not save the submission." Both siblings handle this explicitly — `dashboard/page.tsx:93-95` and `company/page.tsx:38-40` render "No company is provisioned for this account yet." The action itself correctly guards the null case (F5's sibling concern does not apply), so this is a UX consistency gap rather than a correctness bug. Relatedly, no test covers an authenticated user with no company row, where `company_id = NULL` degenerates the policy predicate — it fails closed by construction, but nothing pins it.
- **Fix**: Read `getCompany()` on the page and render the same "No company is provisioned" branch the siblings use.
- **Decision**: FIXED — page reads getCompany() (in parallel with getSubmissions) and renders the siblings' "No company is provisioned" branch.

### F9 — Focus is stranded after a successful delete

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/app/dashboard/submissions/submission-row.tsx:42-49
- **Detail**: The `useEffect` handles arm and disarm carefully but not the success path. Confirm lives inside the row; on success `revalidatePath` removes the row, focus drops to `<body>`, and the keyboard user is thrown to the top of the page — the exact failure the arm/disarm focus handling was written to prevent. Success is also silent: the only message rendered is on the failure path, so nothing announces that the submission was removed. Manual criterion 4.8 covered arm/confirm/cancel reachability, which passes; this is the state *after* confirm, which the criterion did not reach.
- **Fix**: After a successful delete, move focus to a stable anchor outside the row — e.g. the count heading at `page.tsx:42-44` with `tabIndex={-1}` — and announce the removal from a list-level live region that outlives the row.
  - Strength: Closes the one focus transition left unhandled and gives success an announcement.
  - Tradeoff: Requires state to live above the row (the row unmounts), which is a structural change to a component deliberately kept self-contained.
  - Confidence: MEDIUM — the stranding is certain; the cleanest place to put the surviving live region is a design decision.
  - Blind spot: Whether Next's revalidation timing makes a post-unmount focus move reliable without a transition hook.
- **Decision**: FIXED — SubmissionList became a client component owning a persistent role="status" region and focus anchor that outlive the deleted row; date formatting moved up to the page to avoid a server/client divergence. Row calls onDeleted on success.

### F10 — Account-deletion copy does not mention submissions, though the cascade now destroys them

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/dashboard/company/delete-account-form.tsx:31-34
- **Detail**: The `on delete cascade` added by this slice means account deletion now destroys every submission too — correctly reasoned in the migration and flagged in the plan's Migration Notes as a real widening of blast radius. But the confirmation copy still says only "your account and your company data", and that file's own comment at `:15` anticipated this exact moment ("once S-02/S-03 land — every submission and saved plan"). There is no export path in the MVP, so the owner's only warning before irreversible erasure understates what is erased. Modest RODO relevance, since informed consent to erasure is the point of the gate.
- **Fix**: Name submissions explicitly in the confirmation copy.
- **Decision**: FIXED — confirmation copy now names submissions explicitly.

## Minor notes (not tracked as findings)

- `src/app/dashboard/page.tsx:15,19` — `getCompany()` and `getSubmissionCount()` are awaited sequentially though independent; `Promise.all` would halve the page's data latency (`verifySession` is `cache()`d, so the concurrent `getUser()` calls dedupe).
- `submission-form.tsx:62-70` re-inlines the `FieldError` component that `company-profile-form.tsx:22-32` extracted; `labelClass` is inlined at `:41` while `controlClass` is hoisted. Worth lifting into a shared module when a third form appears.
- `SubmissionInput` (`validation.ts:111`) is exported but unused — a planned deliverable with no consumer yet.
- Nothing pins that `SubmissionSchema` strips an injected `source` key. `z.object` is non-strict so it is dropped silently, which is the documented intent; a test would make it a guarantee rather than a Zod default.
- Forward note for S-06: `submissions_insert_own_manual` is scoped `to authenticated`. A logged-in owner scanning *another* company's QR code will be evaluated under that policy, fail the `company_id` check, and be refused. S-06's policy should be `to anon, authenticated with check (source = 'form')` — which does not reopen forgery, since a `'form'` row on another company is exactly what the public form legitimately produces.
