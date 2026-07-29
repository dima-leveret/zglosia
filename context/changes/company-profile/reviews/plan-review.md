<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Company Profile — Owner CRUD for Company Data

- **Plan**: `context/changes/company-profile/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-29
- **Verdict**: REVISE → **SOUND** after triage (all 7 findings fixed)
- **Findings**: 2 critical, 3 warnings, 2 observations

## Verdicts

| Dimension | Verdict (at review) | After fixes |
|-----------|---------------------|-------------|
| End-State Alignment | PASS | PASS |
| Lean Execution | PASS | PASS |
| Architectural Fitness | WARNING | PASS |
| Blind Spots | FAIL | PASS |
| Plan Completeness | FAIL | PASS |

Note: two FAILs would mechanically read RETHINK, but the approach, phase structure, and architecture all survived scrutiny — both criticals were localized edits to Phase 5 and to phase-level success criteria.

## Grounding

5/5 existing paths ✓, 6/6 symbols ✓, brief↔plan ✓, Progress↔Phase 32/32 rows ✓ (30 after triage renumbering), `revalidatePath` from `next/cache` confirmed in fork docs ✓. No `docs/reference/contract-surfaces.md` and no `context/foundation/lessons.md` in this repo — both checks skipped.

## Findings

### F1 — Phase 5's cross-tenant deletion test cannot be written

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 5 — change #3; Progress row 5.4
- **Detail**: Phase 5 specified a test asserting the deleted id derives from the session, but `tests/isolation.test.ts` runs under `environment: 'node'` (`vitest.config.ts`) with no Next runtime. Importing the `'use server'` module yields a plain async function whose `verifySession()` calls `cookies()` from `next/headers`, which throws outside a request scope. Criterion 5.4 was unachievable, and the RLS-layer denial it gestured at is already covered by Phase 4's 4.3.
- **Fix A ⭐ Recommended**: Drop the phase-5 test; record the session-derived-id rule as a code-review invariant.
  - Strength: Phase 4 already proves DB-layer cross-tenant DELETE denial; the residual risk is a code-review invariant, not a DB one.
  - Tradeoff: The service-role path has no automated regression guard.
  - Confidence: HIGH — verified Vitest has no Next runtime.
  - Blind spot: None significant.
- **Fix B**: Add an HTTP-level integration test against a running dev server.
  - Strength: Actually exercises the action end to end.
  - Tradeoff: A whole test tier for one assertion — disproportionate for a 3-week solo MVP.
  - Confidence: MEDIUM — no existing harness to build on.
  - Blind spot: CI cost of running Next unmeasured.
- **Decision**: FIXED via Fix A — Phase 5 change #3 removed and replaced with an explicit "verification boundary" note; criterion 5.4 reworded to plain `npm test`; a "Not covered by automated tests" subsection added to Testing Strategy.

### F2 — signOut() will fail against the just-deleted user

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 5 — change #2; Critical Implementation Details
- **Detail**: The plan ordered deletion as deleteUser → signOut → redirect and said the action "returns a state message on failure". Default `signOut()` is `scope: 'global'`, which calls the server logout endpoint for a user that no longer exists. If that error is treated as failure, the owner sees an error while holding a session cookie for a deleted account.
- **Fix**: Use `signOut({ scope: 'local' })` (verified at `node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:1555`) and treat any sign-out error as non-fatal — once `deleteUser` succeeds, always redirect.
- **Decision**: FIXED — Phase 5 change #2 contract and the Critical Implementation Details ordering bullet both updated.

### F3 — Unfiltered UPDATE leans entirely on RLS

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 — change #3
- **Detail**: The plan carried F-01's filter-free read convention (`src/lib/dal.ts:36`) onto a write. The failure modes are not symmetric: an unfiltered SELECT that over-matches leaks data; an unfiltered UPDATE that over-matches rewrites every visible row.
- **Fix**: Add `.eq('owner_id', user.id)` from `verifySession()`; note the asymmetry so the read-path convention isn't misread as applying to writes.
  - Strength: Bounds the blast radius of any future policy mistake.
  - Tradeoff: Slight inconsistency with the read path's style.
  - Confidence: HIGH — the row is uniquely keyed by `owner_id`.
  - Blind spot: None significant.
- **Decision**: FIXED — filter added to the contract plus a "Why the explicit filter" paragraph; a forward-reference added to Phase 2's DAL contract.

### F4 — Phase 2 verifies only that it compiles

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 success criteria; Phase 4 change #2
- **Detail**: Phase 2's entire automated verification was tsc + build + lint — true of any phase that doesn't break the build — while its actual deliverable's tests sat in Phase 4. The phase could be marked complete with a schema that rejects valid input.
- **Fix**: Move `tests/validation.test.ts` into Phase 2; Phase 4 narrows to two-tenant write isolation.
- **Decision**: FIXED — new Phase 2 change #4, new criterion 2.4 (`npx vitest run tests/validation.test.ts`), Phase 4 renumbered.

### F5 — Phase 1 criteria 1.2/1.3 have no runnable command

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 success criteria
- **Detail**: "query `information_schema.columns`" and "query `information_schema.role_table_grants`" named no command and no connection string, while F-01 had already established a committed `.sql` + `psql` pattern in `supabase/tests/rls_isolation_check.sql`.
- **Fix**: Commit `supabase/tests/company_profile_schema_check.sql` following the F-01 pattern and cite the psql invocation.
- **Decision**: FIXED — new Phase 1 change #4; criteria collapsed into one runnable assertion (1.2) that also absorbs the former manual `updated_at` check.

### F6 — description length cap left to the implementer

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — change #1
- **Detail**: "generous enough for real context" was the only guidance, though the cap is an S-03 prompt-token budget decision.
- **Fix**: State concrete caps.
- **Decision**: FIXED — `name`/`industry`/`location` 120, `description` 2000, with the rationale stated.

### F7 — Widening shared FormState couples login to the profile form

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 2 — change #1
- **Detail**: `FormState` (`src/lib/validation.ts:21`) is consumed by `sendMagicLink` and `login-form.tsx`. Widening its `errors` to carry four company keys makes every future form's fields accumulate in one type.
- **Fix**: Make it generic — `FormState<TFields extends string>` with `errors?: Partial<Record<TFields, string[]>>`.
- **Decision**: FIXED — Phase 2 contract now specifies the generic and notes that existing login usage adapts via `FormState<'email'>`.
