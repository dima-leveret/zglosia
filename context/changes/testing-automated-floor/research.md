---
date: 2026-08-23T16:45:38+0200
researcher: Dmytro Zaichenko
git_commit: 769ddb03ed2c906bc5a00d2a160651f090e3ae95
branch: test-implementation
repository: zglosia
topic: "Ground rollout Phase 1 of context/foundation/test-plan.md — automated floor + migration-state gate (Risks #1, #2)"
tags: [research, codebase, ci, supabase, migrations, grants, vitest, quality-gates]
status: complete
last_updated: 2026-08-23
last_updated_by: Dmytro Zaichenko
---

# Research: Rollout Phase 1 — automated floor + migration-state gate

**Date**: 2026-08-23T16:45:38+0200
**Researcher**: Dmytro Zaichenko
**Git Commit**: `769ddb03ed2c906bc5a00d2a160651f090e3ae95`
**Branch**: `test-implementation`
**Repository**: `zglosia` (`https://github.com/dima-leveret/zglosia`)

> Permalink base for any reference below: `https://github.com/dima-leveret/zglosia/blob/769ddb0/<path>#L<line>`.
> Local `path:line` form is kept in the body because it is clickable in the terminal and this
> document is read from inside the change folder.

## Research Question

Ground rollout Phase 1 of `context/foundation/test-plan.md` ("Automated floor + migration-state
gate") against the real code and configuration. Verify or correct the plan's response guidance for
Risk #1 (a change believed shipped is live only in the repo) and Risk #2 (a new table or column
ships with a wrong grant), locate existing tests, identify the cheapest useful gate layer, and flag
speculative risks or misleading hot-spot evidence.

## Summary

Both risks hold up. Neither is speculative — each has already fired once in this repo and is
recorded in `context/foundation/lessons.md`. The plan's core thesis for Phase 1 is confirmed:
**the assertions for Risk #2 already exist and are good; what is missing is a loop that fires
them.** Three findings change the shape of the phase, though:

1. **The loop cannot run on this machine at all.** The four database-touching suites need the full
   Supabase stack (they provision real auth users through the GoTrue admin API), and there is **no
   Docker binary installed here**. The loop the README documents at `README.md:117-119` has
   therefore never been executable on this machine — exactly matching the lessons.md admission that
   `supabase db reset` was "ticked without ever being run against an empty database". CI is not a
   convenience for this phase; it is the *only* place the from-empty rebuild can happen.

2. **The deploy path is Vercel's native Git integration, not GitHub Actions.** `AGENTS.md` says
   "Vercel Pages via GitHub Actions" — that is imprecise, and it matters. There is no `.github/`
   directory at all. A merge to `main` triggers a Vercel production deploy directly, and nothing in
   that path applies migrations. A GitHub Actions check can gate the *merge*, but it cannot gate the
   *deploy*, because the merge is the deploy trigger.

3. **The current grant state is correct.** Reconstructing every `grant`/`revoke` across all 15
   migrations and diffing it against the verbs the application code actually issues shows an exact
   match, with no unused or over-broad privilege remaining. Risk #2 is therefore a **recurrence**
   risk about the next migration, not an open defect. Phase 1 should be planned as installing a
   trap, not fixing a bug.

One correction to the plan's wording: Phase 1 adds no new *test* code, but it does add code — a
workflow, an env-wiring step, probably a seed file, and a `typecheck` script that does not exist yet.

## Detailed Findings

### Risk #1 — schema drift between repo and deployed database

**Confirmed. The response guidance is right about the assertion target and needs one correction
about timing.**

#### How deploys are actually triggered

- No `.github/` directory exists in the repository (verified by `find .github -type f` returning
  nothing). There is no committed workflow of any kind.
- The deploy mechanism is Vercel's GitHub integration, configured through the dashboard:
  `context/changes/deployment/deployment-plan.md:72` ("merge to `main` triggers production deploy
  automatically") and `deployment-plan.md:75-77` (merges to `main` → production; any PR → preview
  URL; fork PRs get no preview).
- The link is recorded in `.vercel/repo.json` (project `zglosia`, `prj_ZGJTZfXCJ4GTF54sw9sF9xJuY95R`),
  and `.vercel/` is gitignored (`.gitignore:38`).
- There is no `vercel.json` — `deployment-plan.md:291` states zero-config detection is deliberate,
  so there is no Ignore-Build-Step hook configured today either.

**Consequence for the gate.** The Vercel build runs `next build` and serves code. It never touches
`supabase/migrations/`. So the merge that ships the code *is* the moment the drift becomes live, and
a PR-time check can only ever assert the remote state *as it was before* the merge. This is a real
tension with the plan's phrasing "fails visibly before the code that depends on it is serving
traffic", and it is a decision for `/10x-plan` rather than something research can settle — see
[Open Questions](#open-questions).

#### What remote-versus-repo state can be queried, by whom, with which credentials

Verified against the pinned CLI (`supabase` `^2.109.1`, `package.json:31`) via `supabase migration
list --help`:

| Flag | What it reads | Credentials needed |
|---|---|---|
| `--linked` | migrations applied to the linked project | Supabase access token **and** the linked project ref **and** the remote DB password (`--password`) |
| `--db-url <conn>` | migrations applied to the database at that URL | one connection-string secret; no token, no link step |
| `--local` | migrations applied to the local stack | local stack running |

Two details that shape the implementation:

- The global `--output-format json` flag is available on this command, so the local-vs-remote
  comparison is machine-checkable rather than eyeball-parsed. This is what turns "a listing a human
  reads" (the lessons.md failure mode) into an assertion.
- **The project ref is not in the repo.** It lives in `supabase/.temp/project-ref`, and
  `supabase/.gitignore:3` ignores `.temp`. So CI cannot `supabase link` from a clean checkout without
  supplying the ref as a secret. `--db-url` is the lower-friction path: one secret instead of three.

#### Whether any check exists today

None. No workflow, no test in `tests/` that asserts remote migration state, no Ignore-Build-Step. The
only thing standing between a committed-but-unpushed migration and production is the author
remembering — which is precisely the failure recorded in `lessons.md` ("A migration in the repo is
not a migration in the database"), where two fix migrations sat unapplied for a full day while the
review that prompted them was marked resolved.

#### Verdict on the response guidance

- "Assert remote database state, not files in the repo" — **correct and essential**. The
  `migration list` output is the right oracle.
- "Challenge: the linked project works, so the schema is current" — **correct**, and independently
  corroborated: the linked project predates the `auto_expose_new_tables` default change
  (`lessons.md`, first entry), so it is a systematically misleading witness.
- "Cheapest layer: a gate + verification step, no new test code" — **correct in spirit**, but see
  the note below: the phase still adds workflow and tooling code.

### Risk #2 — a table or column ships with a wrong grant

**Confirmed as a recurrence risk. There is no open grant defect today.**

#### Effective grant state, reconstructed across all 15 migrations

Collected every `grant`/`revoke` in migration order. Net effective state:

| Object | Role | Effective privilege |
|---|---|---|
| `public.companies` | `authenticated` | `select`; `update (name, industry, description, location)` |
| `public.companies` | `anon` | none — `revoke all` (`20260809152644_harden_companies_anon_grants.sql:38`) |
| `public.submissions` | `authenticated` | `select`, `delete`; `insert (company_id, content, source)` |
| `public.submissions` | `anon` | `insert (company_id, content, source)` only (`20260809151843:75`) |
| `public.action_plans` | `authenticated` | `select`, `delete` |
| `public.plan_problems`, `plan_problem_submissions`, `plan_actions` | `authenticated` | `select` |
| `public.plan_generations` | `authenticated` | `select`; `insert (company_id)` |
| `current_company_id()` | `authenticated` | `execute` |
| `public_form_company(uuid)` | `anon`, `authenticated` | `execute` |
| `save_action_plan`, `update_action_plan` | `authenticated` only | `execute` (revoked from `anon`/`public`) |

The three corrective migrations that produced this state are
`20260730104500_harden_company_delete.sql:25` (revokes `delete`),
`20260730190000_narrow_company_write_grants.sql:35-37` (revokes table-wide `insert, update`,
re-grants column-scoped `update`), and `20260809152644_harden_companies_anon_grants.sql:38`.

#### What the application code actually exercises

| Table | Verbs in code | Where |
|---|---|---|
| `companies` | `select`, `update` | `src/lib/dal.ts:49-50`, `src/app/dashboard/company/actions.ts:54-57`, `:107-108` |
| `submissions` | `insert`, `select`, `delete` | `src/app/f/[companyId]/actions.ts:114` (anon), `src/app/dashboard/submissions/actions.ts:72-73`, `:148-149`, `src/lib/dal.ts:86-87`, `:308-309` |
| `action_plans` | `select`, `delete` | `src/lib/dal.ts:185-186`, `:271-272`, `src/app/dashboard/plans/actions.ts:591-592` |
| `plan_generations` | `insert`, `select` | `src/app/dashboard/plans/actions.ts:170-172` |
| RPCs | `public_form_company`, `save_action_plan`, `update_action_plan` | `src/app/f/[companyId]/page.tsx:131`, `src/app/dashboard/plans/actions.ts:377`, `:491` |

**The two tables match exactly.** No granted verb is unexercised; no exercised verb is ungranted.
All plan mutations flow through the two `security definer` RPCs rather than table-level writes,
which is why `action_plans` needs no `insert`/`update` grant.

#### The assertions already exist, and their oracle is sound

47 explicit `42501` (permission-denied) assertions across the four database suites:
`tests/isolation.test.ts` (20), `tests/plans.test.ts` (13), `tests/plan-editing.test.ts` (9),
`tests/schema.test.ts` (5).

The FR-004 case the plan singles out — an owner rewriting the company identifier the public form URL
is keyed on — is covered at `tests/isolation.test.ts:299-323`:

```ts
it('denies owner A a rewrite of their OWN companies.id', async () => {
  const { error } = await ownerA.db
    .from('companies')
    .update({ id: '00000000-0000-0000-0000-000000000000' })
    .eq('owner_id', ownerA.userId)

  expect(error?.code).toBe('42501')
  const after = await readOwnerARow()
  expect(after!.id).toBe(ownerA.companyId)
})
```

Two things worth recording about it:

- Its oracle comes from the **requirement** (FR-004 unpredictability, cited in the test's own comment
  at `:300-303`), not from the migration's grant line — the exact anti-pattern the test plan warned
  against is already avoided here.
- It re-reads the row afterwards, so it distinguishes "refused" from "silently did nothing".

The "must challenge" assumption — *RLS is enabled, so the row is protected* — is already internalised
in the codebase's own commentary: `tests/isolation.test.ts:308-311` states that a row policy decides
which rows, never which columns, and that the grant is what refuses the `id` rewrite.

`tests/plan-editing.test.ts:1005-1035` additionally sweeps `UPDATE`/`DELETE`/`INSERT` across the plan
tables in a loop, asserting `42501` for each with the table name in the failure message.

#### Verdict on the response guidance

- "Prove a verb the code never exercises and a column the owner must not rewrite are both rejected on
  a database built from empty" — **already proven in code**; unproven only in the sense that nothing
  runs it from empty. The gap is the runner, not the assertion.
- "Don't derive the expected value from the migration's own grant line" — **already honoured**.
- "Cheapest layer: integration against real Postgres, pattern already in `tests/`" — **correct**,
  with one important sharpening in the next section: it is not "real Postgres", it is "the real
  Supabase stack".

### The blocking finding — what it actually takes to run the existing suite

#### Suite composition

176 tests across 9 files (the plan's "~200" is close; the exact count is 176).

| Kind | Files | Tests | Needs |
|---|---|---|---|
| Pure | `validation` (18), `plan-generation` (22), `plan-editing-schema` (21), `site-url` (10), `qr` (9) | **80** | nothing — no network, no database |
| Database-bound | `isolation` (35), `plan-editing` (24), `plans` (24), `schema` (13) | **96** | full Supabase stack |

#### The database suites need the full stack, not a Postgres container

They provision owners through the GoTrue admin API and then sign in to obtain a real anon-key
session, so RLS applies: `tests/isolation.test.ts:54` (`admin.auth.admin.createUser`), `:65`
(`signInWithPassword`), `:93` (`admin.auth.admin.deleteUser`). They talk to the Supabase API URL,
not a Postgres connection string.

**Consequence:** a bare `postgres:17` service container in CI is insufficient. The runner needs
`supabase start` (Docker), which is available on GitHub-hosted Linux runners.

#### Docker is absent on this machine

`command -v docker` finds no binary. So:

- `npx supabase start` and `supabase db reset --local` cannot run here.
- The loop the README prescribes at `README.md:117-119` (`npx supabase start && npx supabase db
  reset` then `npm test`) is **not executable on this machine today**.
- `.env.test.local` does not exist (only `.env.local`), and `.env.local` points at the **hosted**
  project (`<projectref>.supabase.co`).

Put together: today a bare `npm test` fails at collection in all four database suites, and the only
way they have been run is `npm run test:remote` (`package.json:9`), which sets
`ALLOW_REMOTE_TEST_DB=1` to override the guard and point the suites at the hosted project — the
scenario `tests/support/require-local-db.ts:5-10` explicitly calls a data-loss event, since the
suites create and delete real auth users with the service-role key.

#### The guard fails loudly, which is a property worth protecting

`requireLocalDb` **throws**; it does not skip (`tests/support/require-local-db.ts:20-31`). It is
called at module top level, outside any `it`/`describe`: `isolation.test.ts:31`,
`plan-editing.test.ts:59`, `schema.test.ts:32`, `plans.test.ts:50`. The suites also throw at module
scope if the Supabase env vars are missing (`isolation.test.ts:24-29`).

So a CI job that runs `npm test` with no database and no secrets goes **red at collection**, not
falsely green. That is the correct behaviour and the gate design must preserve it. The tempting
"fix" — making the guard skip when no database is present — would convert Risk #2's entire assertion
set into a silent no-op and is the single most dangerous thing this phase could do.

#### Tooling gaps the phase will hit

- **No `typecheck` script.** `package.json:5-11` has `dev`, `build`, `start`, `lint`, `test`,
  `test:remote`, `test:watch`. §5 of the test plan lists lint + typecheck as required after Phase 1.
  `tsconfig.json:8` already sets `noEmit: true`, so `tsc` is the typecheck; it just needs a script.
  Note that `next build` type-checks by default and `next.config.ts` sets no
  `typescript.ignoreBuildErrors`, so typecheck *is* enforced today — but only on Vercel, after merge.
- **Seeding is enabled with no seed file.** `supabase/config.toml:66-71` sets `[db.seed] enabled =
  true` with `sql_paths = ["./seed.sql"]`, but `supabase/seed.sql` does not exist. Expect a warning
  rather than a failure on `db reset`; confirm it does not fail the gate, or add an empty seed file.
- **No Node version pin.** `package.json` has no `engines` field; local Node is v24.15.0.
  `deployment-plan.md:240-243` already flags this as a possible Vercel mismatch. CI should pin
  explicitly rather than drift from whatever the runner defaults to.

### Hot-spot evidence check

`supabase/migrations/` at 15 commits/30d is consistent with what is on disk — 15 migration files,
4 of them corrective (`harden_company_delete`, `harden_companies_anon_grants`,
`harden_plan_rpc_grants`, `fix_submission_blank_check`), plus `narrow_company_write_grants` and
`bound_plan_problem_count` tightening earlier work. The churn is real authoring, not tooling noise.
**Not misleading evidence.** The 4-of-15 corrective ratio the test plan cites as Risk #2 likelihood
evidence is, if anything, understated at 6-of-15 depending on how `narrow_*`/`bound_*` are counted.

### Speculative-risk check

Neither risk is speculative. Both describe defects that have already occurred and are documented
with dates and consequences in `context/foundation/lessons.md`. Nothing needs to be added to the
codebase before either could break — Risk #1 breaks by omission (forgetting `db push`), and Risk #2
breaks the next time a migration grants a verb the code does not use.

## Code References

- `tests/support/require-local-db.ts:20-31` — the guard; throws, never skips
- `tests/isolation.test.ts:31`, `tests/plan-editing.test.ts:59`, `tests/schema.test.ts:32`, `tests/plans.test.ts:50` — module-scope guard calls
- `tests/isolation.test.ts:299-323` — FR-004 `companies.id` rewrite denial, oracle from the requirement
- `tests/isolation.test.ts:54`, `:65`, `:93` — GoTrue admin provisioning; why bare Postgres is insufficient
- `tests/isolation.test.ts:428-433` — comment recording that a granted `delete` fails silently across tenants (feeds Risk #4, Phase 2)
- `tests/plan-editing.test.ts:1005-1035` — swept `42501` assertions across plan tables
- `vitest.config.ts:29-43` — `loadEnv` with empty prefix; `include: ['tests/**/*.test.ts']`; 30s timeouts
- `supabase/migrations/20260730190000_narrow_company_write_grants.sql:35-37` — column-scoped update grant
- `supabase/migrations/20260804171802_submission_intake.sql:72-80` — revoke-all-then-narrow pattern
- `supabase/migrations/20260814132833_generate_action_plan.sql:209-234` — same pattern across five plan tables
- `src/lib/dal.ts:49-50`, `:86-87`, `:185-186`, `:271-272`, `:308-309` — owner read paths
- `src/app/dashboard/plans/actions.ts:170-172`, `:377`, `:491`, `:591-592` — plan write paths
- `src/app/f/[companyId]/actions.ts:114` — the anonymous insert
- `supabase/config.toml:66-71` — seeding enabled, seed file absent
- `package.json:5-11` — scripts; no `typecheck`
- `.vercel/repo.json` — the linked Vercel project
- `context/changes/deployment/deployment-plan.md:72`, `:75-77`, `:291` — deploy trigger and zero-config decision

## Architecture Insights

- **The migrations follow a consistent, disciplined pattern:** `revoke all` first, then grant the
  narrowest verb, with column lists wherever the owner must not rewrite a field. This pattern is
  visible in `submission_intake` and `generate_action_plan` and was retrofitted onto `companies`.
  A gate that catches deviation from it is guarding a convention the codebase already keeps.
- **Row policies and grants are treated as two distinct layers**, and the tests assert at the layer
  that actually refuses. This is why the suite can distinguish `42501` (grant) from `23503` (FK) from
  a silent zero-row result — and why it is worth running rather than re-writing.
- **Writes are funnelled through `security definer` RPCs** for plans, which keeps the table-level
  grant surface small. Any future gate that diffs grants should expect plan tables to stay
  `select`-only.
- **The repo's quality controls are strong but entirely manual.** Excellent tests, a lessons register
  that names the exact failure modes, a README that documents the right loop — and no automation
  firing any of it. Phase 1 is closing that specific gap, not raising the quality bar.

## Historical Context (from prior changes)

- `context/foundation/lessons.md` — all three entries are Phase 1 material: grants belong in the
  creating migration; a migration in the repo is not a migration in the database; grant the narrowest
  verb and column set. The second entry documents the exact Risk #1 incident, including that the
  integration suite is what eventually caught it — "the tests were right; the database was behind".
- `context/changes/deployment/deployment-plan.md` — establishes the Vercel auto-deploy topology and
  explicitly records that no GitHub Actions workflows exist (`:10`).
- `context/changes/generate-action-plan/`, `context/changes/saved-plans-management/` — the two most
  recent slices; both shipped migrations with the revoke-then-narrow pattern and matching tests.

## Related Research

No prior `research.md` exists in `context/changes/testing-automated-floor/`. This is the first
research artifact for this change. Other change folders under `context/changes/` carry their own
plans but no test-infrastructure research.

## Open Questions

1. **Where does the Risk #1 gate fire — and does it verify or apply?** A PR check can only assert
   the remote state before the merge, but the merge is what deploys. Three shapes are viable, and
   this is a decision for `/10x-plan`:
   - *(a) Post-merge auto-apply* — a workflow runs `supabase db push` on merge to `main`, so schema
     and code land together. Strongest guarantee; requires trusting automation with DDL on
     production.
   - *(b) PR-required verification* — the check fails while any local migration is unapplied
     remotely, forcing the author to push before merging. Keeps a human in the loop; leaves a window
     if the author pushes the migration and then merges much later.
   - *(c) Both* — verify on the PR, then re-assert after deploy.
2. **`--db-url` or `--linked`?** `--db-url` needs one secret and no link step; `--linked` needs
   token + ref + password but keeps the CLI's project awareness. Recommendation from the evidence:
   `--db-url`, because the project ref is gitignored and CI starts from a clean checkout.
3. **Does `supabase db reset` warn or fail with `[db.seed] enabled = true` and no `seed.sql`?**
   Could not be executed here (no Docker). Verify on the runner, or pre-empt it with an empty seed
   file.
4. **Exact `supabase status --override-name` keys** for writing `.env.test.local` in CI. The flag
   exists on the pinned CLI; the specific override key names could not be confirmed without a
   running stack.
5. **Should the local developer loop be fixed too, or is CI enough for this phase?** Docker is
   absent on this machine, so the README's documented loop stays aspirational until it is installed.
   Phase 1 can legitimately deliver CI-only and leave the local loop documented-but-unavailable — but
   that should be a stated choice rather than an oversight.

## Corrections to the test plan

Two items for the post-research backport check. Neither adds a file anchor.

1. **§3 Phase 1 wording — "no new test code" is accurate but incomplete.** The phase adds no test
   *assertions*, but it does add a workflow, env wiring, a `typecheck` script, and possibly a seed
   file. Suggest "adds no new test assertions" to avoid the phase being under-scoped in planning.
2. **§2 Risk #2 response guidance — "integration against real Postgres" understates the
   requirement.** The suites need the full Supabase stack (GoTrue), not just Postgres. Suggest
   "integration against a real Supabase stack". This is a correction to the *cheapest-layer
   hypothesis*, which the handoff explicitly asked to verify rather than accept.

Separately, and outside the test plan: **`AGENTS.md` states the deploy target is "Vercel Pages via
GitHub Actions"**. There are no GitHub Actions; deploys run through Vercel's native Git integration.
Worth correcting whenever `AGENTS.md` is next touched, since Phase 1 is about to add the repo's
first actual GitHub Actions workflow and the two would otherwise be confused.
