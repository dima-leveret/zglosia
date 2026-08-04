<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Submission Intake — Manual Add, List, Delete

- **Plan**: `context/changes/submission-intake/plan.md`
- **Mode**: Deep
- **Date**: 2026-08-04
- **Verdict**: REVISE → **SOUND** after triage (all 6 findings fixed)
- **Findings**: 1 critical, 4 warnings, 1 observation

## Verdicts

| Dimension | Verdict | After fixes |
|-----------|---------|-------------|
| End-State Alignment | PASS | PASS |
| Lean Execution | PASS | PASS |
| Architectural Fitness | WARNING | PASS |
| Blind Spots | FAIL | PASS |
| Plan Completeness | WARNING | PASS |

## Grounding

8/8 paths ✓, 5/5 symbols ✓, brief↔plan ✓, Progress contract ✓ (1 `## Progress`, 5/5 phase names aligned, 39/39 checkboxes match phase Success Criteria, no stray checkboxes in phase blocks). `docs/reference/contract-surfaces.md` absent — surface check skipped.

## Findings

### F1 — Grants are additive only; default privileges may already have granted everything

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Phase 1 — Migration file
- **Detail**: The migration only GRANTs, never revokes. `lessons.md` records that the linked project predates the current Supabase default and *does* auto-expose new tables — the stated reason the F-01 grant gap stayed invisible for three days. `supabase/config.toml:24` has `auto_expose_new_tables` commented out, so the environments diverge: a fresh `db reset` applies no default grants (plan correct), but on the linked project `create table` grants ALL to anon/authenticated/service_role *before* the narrow grants run, which then add nothing. Three headline decisions are silently void there: column-scoped insert (owner can set their own `id` and `created_at`), "no update anywhere", and "nothing ships for anon". RLS still blocks the rows, so it is not a leak — but it defeats the privilege surface the plan is built on, and Phase 1's Studio eyeball was the only thing catching it.
- **Fix A ⭐ Recommended**: `revoke all on public.submissions from anon, authenticated;` immediately after `create table`, before the grant block.
  - Strength: Makes the grant block authoritative in every environment; migration stays self-contained per lessons.md; generalizes to S-03/S-04/S-06.
  - Tradeoff: A statement whose necessity is non-obvious — needs a comment or the next author deletes it as redundant.
  - Confidence: MED-HIGH — grounded in lessons.md's own account; not empirically confirmed against the live database.
  - Blind spot: Whether `service_role` is also auto-granted, and whether revoking from it would break the suites' seeding path.
- **Fix B**: Query live privileges first, then decide.
  - Strength: Replaces inference with fact. Tradeoff: needs Studio/psql mid-plan, and the migration stays environment-dependent for replayers. Confidence: HIGH. Blind spot: None significant.
- **Decision**: FIXED via Fix A. Revoke added to the Phase 1 SQL with a "do not delete this as a no-op" comment; a **Revoke before granting** entry added to Critical Implementation Details; four privilege-negative assertions (anon select, anon insert, explicit-`id` insert, update attempt) added to the Phase 1 test contract as the automated compensating control; `anon` privilege check added to manual criteria (1.8); brief gained a "Privilege authority" decision row.

### F2 — RLS policies call current_company_id() unwrapped

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 — all three policies
- **Detail**: All four existing policies wrap the call — `using (owner_id = (select auth.uid()))` at `20260726104601_owner_auth_tenant_isolation.sql:34,39,44,45,50`. That form forces an InitPlan so the function evaluates once per statement rather than once per row. The plan wrote `company_id = public.current_company_id()` bare, on the one table designed to grow unbounded, and states this policy set is what S-03/S-04/S-06 inherit — so the unwrapped form propagates.
- **Fix**: Wrap all three as `(select public.current_company_id())`.
- **Decision**: FIXED. All three policies wrapped; rationale comment added above the policy block; **Wrap the helper in a subselect** added to Critical Implementation Details.

### F3 — Clear-on-success is specified; preserve-on-failure is not

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 — Add form
- **Detail**: The two behaviours are coupled. React 19 resets uncontrolled forms after a form action completes without distinguishing success from validation failure, so the naive build either clears on both (owner loses up to 2000 typed characters to a whitespace rejection) or on neither (plan requirement fails). `company-profile-form.tsx` never exposes this because every field re-fills from a `defaultValue` prop; the add form has no row to re-fill from and is the first place the reset is observable.
- **Fix A ⭐ Recommended**: Echo submitted content back through `FormState`; textarea stays uncontrolled with `defaultValue` reading from it.
  - Strength: Extends the existing generic `FormState<TFields>`, keeps the uncontrolled pattern both forms use, one mechanism for both criteria.
  - Tradeoff: `FormState` grows a non-error payload field.
  - Confidence: MED — React 19 reset semantics could not be confirmed in this fork's docs.
  - Blind spot: AGENTS.md warns the fork has breaking changes; behaviour must be checked empirically in Phase 3.
- **Fix B**: Controlled textarea cleared explicitly on success. Strength: immune to fork behaviour. Tradeoff: first controlled input in the app, diverges from both existing forms. Confidence: HIGH. Blind spot: None significant.
- **Decision**: FIXED via Fix A. Phase 3 form contract rewritten to state the coupling, prescribe the echo-back mechanism, and require empirical verification of the reset behaviour in this fork; manual criterion 3.8 added ("a rejected submission keeps the owner's typed content"); brief gained a matching open risk.

### F4 — Phase 1 criterion 1.1 is conditionally waivable

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Success Criteria / Progress 1.1
- **Detail**: The criterion read "`npx supabase db reset` (or, if no container runtime is available, record that…)", which makes it unfalsifiable. `lessons.md` says this exact criterion is "only tickable after an actual `supabase db reset` from empty — never inferred". F1 is precisely the class of bug a from-empty replay catches and the linked project hides.
- **Fix A ⭐ Recommended**: Split into a hard `migration list --linked` gate plus a separate, explicitly-blocked from-empty item naming the missing container runtime.
  - Strength: Keeps one checkable hard gate; the gap stays visible instead of ticked. Tradeoff: Phase 1 closes with an acknowledged unverified property. Confidence: HIGH — matches how S-01's F1 was resolved. Blind spot: None significant.
- **Fix B**: Make a container runtime a prerequisite. Strength: actually closes the gap. Tradeoff: blocks the slice on setup S-01 already abandoned. Confidence: MED. Blind spot: None significant.
- **Decision**: FIXED via Fix A. Criterion 1.1 is now the remote-apply gate; 1.2 is "BLOCKED, no container runtime — record, do not tick by inference", with the privilege negatives named as the compensating control; brief risk updated.

### F5 — createSubmission/deleteSubmission unspecified when getCompany() returns null

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — Create action / Phase 4 — Delete action
- **Detail**: `getCompany()` is typed to return `null` (`src/lib/dal.ts:36-50`) and both existing pages render a "No company is provisioned" branch. The plan said only "resolve `company_id` from `getCompany()`" — the obvious build dereferences null and throws into `src/app/dashboard/error.tsx` for a state the rest of the app handles gracefully.
- **Fix**: Specify the early return — null company → generic failure message, no write attempted, in both actions.
- **Decision**: FIXED. Both action contracts now name the null branch explicitly.

### F6 — created_at ordering has no tiebreaker

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Submission reads / Phase 1 — index
- **Detail**: `order('created_at', { ascending: false })` alone is non-deterministic for rows sharing a timestamp. Phase 5 seeds fixtures through the service-role client where two inserts land on the same `now()` — a flaky ordering assertion, and a list that can reshuffle between renders.
- **Fix**: Add `id` as secondary sort key and to the index.
- **Decision**: FIXED. Index is now `(company_id, created_at desc, id desc)` with a comment; `getSubmissions()` contract adds the matching secondary order.

## Post-triage state

All six findings fixed in `plan.md`; `plan-brief.md` updated with one new decision row and two revised risks. Progress contract re-verified after the edits: 1 `## Progress`, 5/5 phase names aligned, 39/39 checkboxes matching phase Success Criteria, no checkboxes outside the Progress section.

**Verdict after fixes: SOUND.**
