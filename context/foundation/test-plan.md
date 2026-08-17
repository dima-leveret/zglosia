# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-08-17

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the
   risk wins. Do not promote to e2e because e2e "feels safer." Do not put a
   vision model on top of a deterministic visual diff that already catches
   the regression. In this repo the principle has an unusual first
   consequence: the highest-value move is not writing tests but running the
   ones that exist — see §3 Phase 1.
2. **User concerns are first-class evidence.** Risks anchored in "the owner
   is worried about X, and the failure would surface somewhere in `<area>`"
   carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents *what
   could fail* and *why we believe it's likely* — drawn from documents,
   interview, and codebase *signal* (churn, structure, test base). It does
   NOT claim to know which line owns the failure. That knowledge is
   produced by `/10x-research` during each rollout phase. If the plan and
   research disagree about where the failure lives, research is the
   ground truth.

Hot-spot scope used for likelihood weighting: `src/`, `supabase/migrations/`
(36 commits / 30d, measured 2026-08-17).

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by
risk = impact × likelihood. Risks are failure scenarios in user / business
terms, not test names. The Source column cites the *evidence that surfaced
this risk* — never a specific file as "where the failure lives" (that is
research's job, see §1 principle #3).

| # | Risk (failure scenario) | Impact | Likelihood | Source (evidence — not anchor) |
|---|---|---|---|---|
| 1 | A change believed shipped is live only in the repo: the deployed app runs against a schema that is behind, so a privilege the migration was written to close is still open in production | High | High | interview Q2 (already happened); `lessons.md` "A migration in the repo is not a migration in the database"; hot-spot dir `supabase/migrations/` — 15 commits/30d; roadmap §Baseline (no committed CI; Vercel auto-deploy carries code, not migrations) |
| 2 | A new table or column ships with a wrong grant — too narrow, so every owner read fails on a database built from empty; or too broad, so an owner rewrites a column they must not, including the company identifier FR-004 requires unpredictable | High | High | interview Q3; `lessons.md` "Grants ship in the migration that creates the object" and "Grants: narrowest verb, and narrowest column set"; 4 of 15 migrations are corrective; PRD FR-004 + NFR (brak enumeracji) |
| 3 | An unauthenticated request reaches an owner route and is served instead of being redirected to login | High | High | interview Q4; PRD §Access Control ("Nieuwierzytelniony użytkownik … jest kierowany do logowania"); AGENTS.md hard rule — this Next fork renames the request-interception layer, so training-data patterns are actively wrong; hot-spot dir `src/app/login/` — 10 commits/30d |
| 4 | An owner's write is silently no-op'd by row-level policy and the interface reports success — the owner believes an edit or delete landed when nothing changed | Medium | High | hot-spot dirs `src/app/dashboard/plans/` — 17 commits/30d and `src/app/dashboard/submissions/` — 13 commits/30d; roadmap S-04 in flight; PRD FR-014; no tests exist on the server-action layer |
| 5 | A customer is shown a confirmation for a submission that was never persisted | High | Medium | PRD §Guardrails and NFR ("Żadne wysłane zgłoszenie nie ginie"); PRD US-02 acceptance criteria; hot-spot dir `src/app/f/[companyId]/` — 7 commits/30d; `context/changes/public-submission-form/` |
| 6 | Concurrent requests slip past the daily generation cap, running the paid LLM step more times than the cap allows | Medium | Medium | PRD NFR + Open Questions 2 and 3; `context/changes/generate-action-plan/`; hot-spot dir `src/app/dashboard/plans/` — 17 commits/30d |

Abuse lens: #2 covers over-broad privilege, #3 covers authorization/access,
#6 covers resource abuse. The public form's spam resistance is a stated NFR
with an undecided acceptance level (PRD Open Question 3) and no known
defense in place — testing it would require adding the safeguard first, so
it is a roadmap gap rather than a risk row here (see §7).

### Risk Response Guidance

| Risk | What would prove protection | Must challenge | Context `/10x-research` must ground | Likely cheapest layer | Anti-pattern to avoid |
|---|---|---|---|---|---|
| #1 | Merging a schema change without applying it fails visibly before the code that depends on it is serving traffic | "the linked project works, so the schema is current" — the linked project predates the default that broke the from-empty case | how deploys are triggered; what remote-versus-repo migration state can be queried and by whom; whether any check exists today | gate + verification step — no new test code | asserting on files in the repo instead of on remote database state |
| #2 | A verb the code never exercises, and a column the owner must not rewrite, are both rejected on a database built from empty | "row-level security is enabled, so the row is protected" — policies scope which rows, never which columns | which verbs each code path actually exercises; whether a from-empty rebuild is runnable inside the feedback loop | integration against real Postgres — the pattern already exists in `tests/` | deriving the expected value from the migration's own grant line; the oracle must come from the code path, not the schema |
| #3 | A request carrying no session, and one carrying a session for the wrong company, both fail to render owner content on every owner route including dynamic child segments | "the happy-path login works, so the gate works"; separately, "a cookie is present, therefore the session is valid" | where request interception actually runs in this fork — read `node_modules/next/dist/docs/`, not training data; which route patterns are matched; what a stale or forged token produces | integration | covering only the top-level dashboard route and missing dynamic child routes |
| #4 | A blocked write reports failure to the owner rather than success | "the call returned without throwing, so it wrote" — a policy-silenced write returns no error and affects no rows | how the action layer distinguishes zero-rows-affected from success; what the interface renders in each case | integration at the server-action layer | asserting the return value only and never the persisted state |
| #5 | Every path that shows the customer a confirmation has a persisted row behind it, including when validation or the anonymous grant rejects the insert | "the form posted, so it saved" | the anonymous insert path end to end; what the client is shown when the insert is refused | integration | mocking the database edge — the refusal under test lives exactly there |
| #6 | Parallel requests at the cap boundary produce exactly the capped number of generations, not more | "the cap test passes, so the cap holds" — the existing test is sequential and does not exercise the race | how serialization is expressed at the data layer; whether the request path re-checks or trusts an earlier read | integration, concurrent | reusing the existing sequential cap test as though it covered concurrency |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder
via `/10x-new`. Status moves left-to-right through the values below; the
orchestrator updates Status as artifacts appear on disk.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|---|---|---|---|---|---|
| 1 | Automated floor + migration-state gate | Make the suite that already exists run on every change, and make an unapplied migration fail loudly instead of silently | #1, #2 | gates, migration-state verification (no new test code) | change opened | `context/changes/testing-automated-floor/` |
| 2 | Auth gate + server-action surface | Prove owner routes reject an unauthenticated or wrong-company request, and that a blocked write reports failure rather than success | #3, #4 | integration | not started | — |
| 3 | Public intake durability + cap under load | Prove no confirmed submission is lost on the anonymous path, and that the generation cap holds under concurrency | #5, #6 | integration, concurrency | not started | — |
| 4 | E2E on the two flows nothing cheaper covers | Browser-level: logged-out to login to dashboard, and customer submits to owner sees | #3, #5 | e2e | not started | — |

**Order rationale.** Phase 1 is first and deliberately adds no tests. Risks
#1 and #2 are both already asserted by the existing suite — permission
denials are proven against real Postgres across three test files. What is
missing is a loop that fires them. Writing more grant tests would be waste;
wiring the ones that exist is the cheapest real signal available in this
repo, and every later phase lands on that floor.

**No AI-native rollout phase is scheduled.** None clears cost × signal here
against a deterministic alternative. AI-native options are still recorded in
§4 and §5 with `checked:` dates and explicit *when not to use* conditions —
including the strongest candidate for this project, a migration-diff review
against the three grant rules in `lessons.md`, which gives signal at
authoring time that no deterministic test gives cheaply. Wiring it is hook
configuration and belongs to a later lesson; this plan names it only.

## 4. Stack

The classic test base for this project. AI-native tools carry a `checked:`
date so future readers can see which lines need re-verification. Tool names
are examples of their category, not endorsements.

| Layer | Tool | Version | Notes |
|---|---|---|---|
| unit + integration | Vitest | 4.1.10 | Configured; node environment; collects `tests/**/*.test.ts` only. ~200 tests across 9 files. |
| database / policy integration | Vitest against real Postgres | 4.1.10 | Deliberate: row-level policy behavior cannot be proven against a mock. Database-touching suites refuse a non-local host. |
| API mocking | none — by policy, not gap | — | The refusals under test live at the database edge. Mocking it would remove the assertion. Revisit only if an external HTTP boundary other than the LLM provider appears. |
| component / UI | none yet | — | Not scheduled. No rollout phase points at it; see §7. |
| e2e | none yet — see §3 Phase 4 | — | Runner to be chosen and installed by that phase. Two flows only. |
| accessibility | none yet | — | Optional; no phase scheduled. Add when a screen becomes customer-facing beyond the single public form. |
| CI gates | none yet — see §3 Phase 1 | — | No committed workflow. Vercel auto-deploys on merge; nothing runs the suite first. |
| (optional) AI-native | migration-diff review against `lessons.md` grant rules — checked: 2026-08-17 | n/a | **When NOT to use:** once a from-empty rebuild runs automatically in the loop, the deterministic check is cheaper and authoritative — keep the review only as an authoring-time hint, never as the gate. |
| (optional) AI-native | multimodal visual review, 1–3 screens — checked: 2026-08-17 | n/a | **When NOT to use:** anywhere a deterministic assertion already covers the behavior, and on any screen whose failure is textual rather than visual. Low value here — no design system, single builder. |
| (optional) AI-native | vision-driven fallback (Computer Use / CUA) — checked: 2026-08-17 | n/a | **When NOT to use:** any surface reachable through the DOM. Expensive per action. No known DOM-unreachable surface in this product; listed for completeness only. |

**Stack grounding tools (current session):**

- Docs: Vercel documentation MCP available (`search_vercel_documentation`); the Next fork's own docs are on disk and were confirmed to carry a Vitest guide at `node_modules/next/dist/docs/01-app/02-guides/testing/` — that local copy is authoritative over any external Next docs, per the AGENTS.md hard rule. Context7 — not available in current session; checked: 2026-08-17
- Search: web search and fetch available in session; not exercised this run — every stack fact above came from local manifests and configs. Exa.ai — not available in current session; checked: 2026-08-17
- Runtime/browser: no Playwright MCP in current session. A Chrome automation skill is present but is per-site permissioned and human-in-the-loop, so it is a debugging aid, not a gate-able layer. §3 Phase 4 must install its own runner; checked: 2026-08-17
- Provider/platform: Vercel MCP available (deployment listing, build logs, runtime logs, runtime errors) — relevant to a post-deploy smoke gate in §5. Vercel CLI not installed. Supabase is present as a dev dependency CLI, not as an MCP — its remote migration listing is the evidence source for Risk #1. No GitHub MCP; `gh` CLI is available; checked: 2026-08-17

## 5. Quality Gates

The full set of gates that must pass before a change reaches production.
"Required after §3 Phase N" means the gate is enforced once that rollout
phase lands; before that, the gate is planned.

| Gate | Where | Required? | Catches |
|---|---|---|---|
| lint + typecheck | local + CI | required after §3 Phase 1 | syntactic and type drift |
| unit + integration | local + CI | required after §3 Phase 1 | logic regressions, policy and grant regressions |
| migration applied remotely | CI on PR / pre-deploy | required after §3 Phase 1 | Risk #1 — a fix live only in the repo |
| from-empty database rebuild | CI on PR | required after §3 Phase 1 | Risk #2 — a missing grant invisible on a long-lived database |
| e2e on critical flows | CI on PR | required after §3 Phase 4 | broken login gate, broken customer submission path |
| migration-diff review against grant rules | local (agent loop) | recommended, not scheduled | over-broad or missing privileges at authoring time |
| post-deploy smoke via provider logs | after deploy | optional | environment-specific failures the local suite cannot see |
| multimodal visual review | CI on PR | optional | visual issues a deterministic diff misses |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the
relevant rollout phase ships; before that, the sub-section names the pattern
it will carry.

### 6.1 Adding a unit test for a validation or pure helper

- **Location**: `tests/<subject>.test.ts`.
- **Naming**: one file per subject, matching `tests/**/*.test.ts`.
- **Reference test**: `tests/validation.test.ts` — asserts boundaries exactly at the cap and one past it, and measures after trimming.
- **Run locally**: `npm test`.

### 6.2 Adding an integration test for a policy or grant

- **Location**: `tests/<area>.test.ts`, alongside the existing suites.
- **Mocking policy**: none. These tests run against real Postgres; the refusal being asserted is the database's. Suites requiring a database guard on a local host.
- **Reference test**: `tests/isolation.test.ts` — proves denials are policy and not absence by confirming both rows exist first.
- **Run locally**: `npm test`, or `npm run test:remote` against a remote database.

### 6.3 Adding a test for a server action

- TBD — see §3 Phase 2 for the blocked-write-reports-failure pattern (Risk #4).

### 6.4 Adding a test for route protection

- TBD — see §3 Phase 2 for the unauthenticated-request-is-redirected pattern (Risk #3), including dynamic child routes.

### 6.5 Adding an e2e test

- TBD — see §3 Phase 4. Two flows only; anything a cheaper layer covers does not belong here.

### 6.6 Per-rollout-phase notes

(Filled in by each phase's final sub-phase as it lands.)

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout. Future contributors should respect
these unless the underlying assumption changes.

- **The LLM's output quality — the model's actual text.** Assertions on generated prose are flaky and prove nothing durable. Test the grounding rules instead: citation resolution, refusal of foreign or non-existent citations, and preservation of the original snapshot on edit — all of which are already covered. Re-evaluate if the product ever promises a property of the text itself rather than of its grounding. (Source: Phase 2 interview Q5.)
- **The public form's spam-resistance threshold.** The NFR names the property but PRD Open Question 3 leaves the acceptance level undecided, and no defense is known to be in place. Testing it would mean adding the safeguard first. This is a roadmap gap, not a test gap. Re-evaluate once an acceptance level is chosen and a defense ships. (Source: PRD §NFR + Open Question 3; roadmap S-06 Unknowns.)
- **Growing QR rendering coverage.** Determinism, encoding settings, and print width are already asserted; the library is the test for everything beyond that. Re-evaluate if the download route and the on-screen render ever stop sharing one encoder. (Source: existing `tests/qr.test.ts` under §1 cost × signal.)

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-08-17
- Stack versions last verified: 2026-08-17
- AI-native tool references last verified: 2026-08-17

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.
