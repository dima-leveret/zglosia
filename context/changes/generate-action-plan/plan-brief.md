# Generate Action Plan (S-03) — Plan Brief

> Full plan: `context/changes/generate-action-plan/plan.md`

## What & Why

Roadmap slice **S-03**, the product's ⭐ north star (US-01, FR-011, FR-012). An owner presses
one button and their raw customer submissions become a ranked set of recurring problems plus
concrete action steps, which they review and save to the company account. This is the step
from summary to plan — the roadmap's own test of whether ZGŁOSIA is anything more than
"kolejne narzędzie do statystyk".

## Starting Point

Everything upstream is done, and three constants exist today *only* for this slice, saying so
in their doc comments: `SUBMISSION_CONTENT_MAX = 2000` ("an S-03 prompt-token budget"),
`SUBMISSION_LIST_LIMIT = 100` ("the owner's next action is generate a plan from all of
these"), and `CompanyProfileSchema`'s four fields ("shaped as company context for the S-03
action-plan prompt"). The submission-intake migration states outright that its RLS shape "is
what S-03 inherits". What is missing: any LLM dependency, any API key, any plan table, any
route under `/dashboard/plans`.

## Desired End State

An owner presses **Generate action plan**, watches staged progress, and within a minute reads
a Polish plan where every problem shows the customer submissions it came from. They save it
and it lands at its own URL, findable later. Zero submissions gets an explanation instead of a
button; one to four gets an honest "this may be thin" note. A fabricated citation cannot be
saved — Postgres refuses it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| LLM access | AI SDK + `@openrouter/ai-sdk-provider` | Keeps the documented OpenRouter decision while getting schema-validated structured output instead of hand-rolled JSON repair. |
| API surface | `generateText` + `Output.object` | `generateObject` is **deprecated in AI SDK v6**; the result property is `output`, not `object`. |
| Grounding | Cited submission IDs, verified server-side *and* in SQL | Makes the anti-hallucination NFR a database fact — a citation the caller doesn't own produces no row and aborts the save. |
| Citation encoding | Numbered indexes, not uuids | A model asked to echo uuids corrupts them; an integer in a small range is verifiable and trivially range-checked. |
| Storage | Relational: plans → problems → citations → actions | Citations become real foreign keys, and S-04's per-item editing becomes ordinary row updates. |
| Write path | `security definer` RPC only, no insert grant | supabase-js has no transactions, and a four-table save must not half-land. |
| Save timing | Review, then explicit save | Matches PRD US-01 literally; the round trip is not a trust boundary because the RPC re-derives every guarantee. |
| Pre-save editing | None — read + accept/discard | The PRD marks edit-before-save as insufficient on its own; an editor built now gets rewritten by S-04. |
| Progress UX | Server Action + staged status copy | Reuses the form/action/pending pattern every other write uses; no new transport. |
| Threshold | Block at zero, warn below five | Satisfies the PRD acceptance criterion exactly without blocking an owner who genuinely wants a plan from three. |
| Bad citations | Drop the problem, fail if all drop | Nothing ungrounded is ever saved, but one bad item doesn't waste the wait and the spend. |
| Timeout | Abort at 60s, no auto-retry | Well inside Vercel's 300s limit, so failures surface as our message rather than the platform error `infrastructure.md` flags as top risk. |
| Spend cap | Ledger row written *before* the call, `PT429` at 10/day | With review-then-save, capping saves would leave generate-and-discard unbounded. |
| Model | Mid-tier, pinned in `ZGLOSIA_PLAN_MODEL` | Swapping models becomes config, not a deploy. |
| Language | Polish content, English UI chrome | Extends the split S-06 documented; the plan is the one artifact the Polish owner acts on. |
| Testing | Stubbed model + real-Postgres contract suite, one live run | Deterministic and free in CI, matching the existing `tests/*.test.ts` style. |

## Scope

**In scope:** one migration (four plan tables, generation ledger, `PT429` cap trigger, narrow
grants, RLS, atomic `save_action_plan` RPC); regenerated types; full DB contract suite; AI SDK
+ OpenRouter wiring; Polish prompt builder and output schema; generation action with abort and
citation verification; review/save UI with threshold gating; one read-only saved-plan page.

**Out of scope:** plan list, edit, delete (S-04/FR-013/FR-014); editing before save; streaming;
regeneration and versioning; retries and queues; notifications and exports; per-submission
plans; observability tooling; ledger pruning.

## Architecture / Approach

```
/dashboard/plans/page.tsx ──> getSubmissionCount()  0 → empty state | 1-4 → warn | 5+ → button
        │
        ▼  useActionState(generatePlan)
actions.ts  1. verifySession() + getCompany()
            2. insert plan_generations   ← BEFORE the model call; trigger raises PT429 at 10/day
            3. generateText({ output: Output.object(schema), abortSignal: 60s })
            4. map submissionIndexes → real ids; drop ungrounded problems
        │
        ▼  plan returned to client, reviewed, posted back
savePlan ──rpc──> save_action_plan(summary, problems jsonb)   [security definer, one transaction]
                    insert citations … select … where company_id = current_company_id()
                    row count mismatch → RAISE  ← the grounding guarantee
```

The application is an honest caller, not a boundary. Grounding and spend are both enforced in
Postgres and hold against a direct PostgREST call.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema & save RPC | Four plan tables, ledger + cap trigger, grants, RLS, atomic RPC, types | `lessons.md` twice over: grants ship with the table, and a migration in the repo is not one in the database |
| 2. DB contract tests | Grants, cross-tenant denial, RPC grounding refusal, cascade, `PT429` | Denials must assert a SQLSTATE — an empty array also means "granted select, no policy match" |
| 3. Generation path | AI SDK + OpenRouter, prompt, output schema, abort, citation verification | v6's `result.output` vs `.object` fails silently as "the model returned nothing" |
| 4. Review & save UI | Button, staged progress, review screen, save/discard, threshold gating | Progress stages are time-based theatre; they must not claim precision that isn't there |
| 5. Saved view & acceptance | Read-only plan page, live end-to-end run | The live run is the only check on plan *quality* and cannot be automated |

**Prerequisites:** F-01, S-01 and S-02 implemented (all done). Supabase CLI linked; a local
Supabase for the from-empty reset; `.env.test.local` for the DB suites. An OpenRouter account
and API key, set locally and in Vercel. 15–30 realistic Polish submissions for Phase 5.

**Estimated effort:** ~2–3 sessions across five phases. Phase 1 is the largest migration in the
product; Phase 3 needs prompt iteration; Phase 5 is short but gated on human judgement.

## Open Risks & Assumptions

- **Plan quality is unverifiable by automation.** Every test here proves the plumbing and the
  grounding; none proves the plan is *useful*. Phase 5's manual criterion ("reads as advice the
  owner could act on") is the only gate, and it may take prompt iteration to pass.
- **OpenRouter's structured-output support is the one link not verifiable from this repo.** The
  community provider's docs don't document JSON-schema mode, so behaviour depends on the chosen
  model. `NoObjectGeneratedError` is handled explicitly so a wrong assumption surfaces as a
  clean failure rather than corrupt data.
- **The cap is per company per day, so an owner iterating on their plan can lock themselves out.**
  Accepted: it bounds spend, and 10 is generous for a deliberate action.
- **A refresh during review destroys the result** — 60 seconds and a paid call. The consequence
  of review-then-save without a staging table; `sessionStorage` was considered and rejected on
  RODO grounds (customer-derived text in browser storage).
- **Citations cascade on submission delete**, so an owner deleting submissions can leave a saved
  problem with no visible support. Deliberate — the plan records what was true when generated —
  but it means "grounded" is a statement about generation time, not forever.
- **First paid external dependency in the product**, adding a runtime failure mode (provider
  down, quota exhausted, model deprecated) that no existing path has.

## Success Criteria (Summary)

- An owner turns their submissions into a saved, Polish action plan they could not have
  assembled by hand — and can find it again afterwards.
- Every problem in a saved plan links to real submissions of that owner's company; the database
  refuses anything else, even from a tampered client.
- `npm run test:remote` proves plan data is unreachable across tenants and that generation is
  capped, without spending a cent on the model.
