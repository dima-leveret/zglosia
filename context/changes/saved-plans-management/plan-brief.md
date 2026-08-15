# Saved Plans Management (S-04) — Plan Brief

> Full plan: `context/changes/saved-plans-management/plan.md`

## What & Why

Roadmap slice **S-04** (FR-013, FR-014). S-03 proved the north star — raw submissions become a
saved action plan — but the plan it saves is a dead end: one read-only page, reachable through a
single "latest plan" link, unchangeable and undeletable. This slice makes saved plans manageable:
an index of everything saved, whole-plan editing that preserves what the model originally wrote,
and deletion. The roadmap's own caveat is the design constraint — *"pożądane zachowanie oryginału
generacji, by edycja nie zacierała, co dał model."*

## Starting Point

The schema was built for this and deliberately stops at its edge. `20260814132833_generate_action_plan.sql`
says so in prose: *"FR-013 and FR-014 are S-04, so there is no update grant, no delete grant, no
updated_at column and no touch trigger anywhere in this file."* Two placeholders are waiting to be
replaced — `getLatestActionPlan()` ("one row rather than a surface S-04 would then have to
replace") and the `PLAN_SAVED` message ("kept for S-04's save-in-place edits"). What exists and
gets reused: `getActionPlan()`'s single-round-trip embedded read, the generic `touch_updated_at()`
trigger function, the `submission-row.tsx` two-step delete pattern with its focus and live-region
work, and `tests/plans.test.ts`'s SQLSTATE-per-denial contract style.

## Desired End State

The owner opens `/dashboard/plans` and sees every plan they have saved — date, problem count, an
"edited" marker. They open one, press Edit, fix the model's clumsy wording, drop the problem that
missed the point, and save without leaving the page. The plan then shows when it was edited and
offers a read-only view of what the model originally produced. Plans they no longer want are
deleted from the list or from the plan's own page behind a two-step confirm.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Edit scope | Text in place **plus** removing problems and actions | Covers both "dopracować" and "sprzątać"; adding items is excluded because an owner-authored problem would cite nothing. | Plan |
| Preserving the original | `original_content jsonb`, snapshotted on **first** edit | Answers the roadmap's concern with one column and one write — no version table, no history UI. | Plan |
| Write path | One `update_action_plan` RPC takes the whole desired state | Removal becomes "this id wasn't in the payload", so a whole-plan save is one transaction and the four tables stay `select`-only. | Plan |
| Invariant enforcement | Inside the RPC, on distinct SQLSTATEs | Same boundary `save_action_plan` established — the ≥1-problem / ≥1-action floors hold against a leaked anon key, not just against the UI. | Plan |
| Rank gaps | Renumbered contiguously inside the same transaction | The detail page renders the **stored** `rank` by explicit prior decision, so gap-free numbering is what keeps "#1, #2, #3" honest. | Plan |
| Plan delete | Direct `delete` grant + RLS delete policy on `action_plans` only | A whole-plan delete has no invariant to protect; children cascade, and it mirrors `deleteSubmission` exactly. | Plan |
| Delete UX | Two-step inline arm, on list rows and the detail page | Reuses the built pattern; a plan is regenerable, so it does not warrant the type-to-confirm gate reserved for account erasure. | Plan |
| List IA | `/dashboard/plans` becomes generator + saved list | One route for everything about plans, and it retires `getLatestActionPlan()` exactly as that function's own comment predicted. | Plan |
| Edit UI | Whole-plan edit mode, one save | One round trip means the snapshot is written once, atomically; removals stage in client state so Cancel is a true no-op. | Plan |
| Form encoding | One hidden JSON field, like `savePlan` | The editor is controlled anyway, so client state *is* the echo — the 50-field echo-back problem disappears. | Plan |
| Paging | Capped at 50, not paginated | Same reasoning `SUBMISSION_LIST_LIMIT` documents, and generation is already capped at 10/company/day. | Plan |
| Citations | Never touched by editing | `plan_problem_submissions` is the anti-hallucination NFR as foreign keys; editing rewrites prose, not evidence. | Plan |

## Scope

**In scope:** one migration (`updated_at` + touch trigger, `original_content jsonb`, `delete` grant
+ RLS delete policy on `action_plans`, the `update_action_plan` RPC with its `anon` revoke);
regenerated types; a DB contract suite for editing; `getActionPlans()` and the retirement of
`getLatestActionPlan()`; the plans index; `deletePlan` and `updatePlan` actions; list/row/detail/
editor components; the original view.

**Out of scope:** adding problems, actions or citations; reordering; editing citations; version
history; one-click revert to original; pagination; regeneration into an existing plan; export,
comparison, notes, sharing; any change to `save_action_plan`, the generation path, or the spend
cap; observability.

## Architecture / Approach

```
/dashboard/plans  ──> getActionPlans()  → PlanList → PlanRow (link + 2-step delete)
       │                                              └─ deletePlan ── delete ──> action_plans (RLS)
       ▼
/dashboard/plans/[id] ──> getActionPlan() → PlanDetail ─┬─ read view
                                                        ├─ PlanEditor (controlled, staged removals)
                                                        └─ original view (parsed jsonb)
                                     │
                                     ▼ one hidden JSON field
                        updatePlan ──rpc──> update_action_plan(plan_id, summary, problems jsonb)
                                              [security definer, one transaction]
                                              1. company from session, never an argument
                                              2. snapshot original if null  ← from STORED rows
                                              3. verify every posted id belongs to this plan
                                              4. delete what's absent, update what survives
                                              5. renumber rank/position, offset pass
```

The application stays an honest caller, not a boundary. Tenancy, the floors, and id ownership are
all re-derived in Postgres and hold against a direct PostgREST call.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema, edit RPC & grants | Two columns, touch trigger, delete grant + policy, `update_action_plan`, types | `check (rank > 0)` rules out negate-then-renumber — the offset pass must be right or any non-last removal raises `23505`; and `revoke … from public` does **not** remove Supabase's direct grant to `anon` |
| 2. DB contract tests | Cross-tenant, foreign-id, both floors, renumber contiguity, snapshot-once, standing write denials | Every denial must assert a SQLSTATE — an empty array also means "granted select, no policy match" |
| 3. Plans index + delete | `getActionPlans()`, the index page, `deletePlan`, list/row components | Retiring `getLatestActionPlan()` — `tsc` is what finds every remaining reference |
| 4. Edit mode + original view | `PlanEditSchema`, `updatePlan`, the controlled editor, "edited" marker and original | Floors must be blocked in the UI too, or the owner's first feedback is a generic failure |
| 5. Acceptance | Manual end-to-end on real data | Only human judgement can say whether an edited plan still reads as advice |

**Prerequisites:** S-03 implemented (done). Supabase CLI linked; a local Supabase for the
from-empty reset; `.env.test.local` for the DB suites. Two owner accounts and several saved plans
generated from realistic Polish submissions for Phases 2 and 5.

**Estimated effort:** ~2 sessions across five phases. Phase 1 is the bulk of the thinking; Phase 4
is the bulk of the UI.

## Open Risks & Assumptions

- **The renumber is the one genuinely tricky piece of SQL.** `unique (plan_id, rank)` plus
  `check (rank > 0)` leaves only an offset pass, and getting it wrong fails exactly in the case the
  slice exists for — removing any problem other than the last.
- **"Grounded" remains a statement about generation time.** Editing preserves citations, but S-03
  already established that deleting a submission cascades them away; an edited plan can still end
  up with a problem showing no support.
- **One snapshot, not a trail.** An owner who edits twice can compare against the model but not
  against their own previous version. Accepted for a `speed`-goal MVP.
- **The original is viewable, not restorable.** If an owner wants the model's version back they
  retype it or regenerate.
- **A stale tab loses its edit.** Concurrent edits are serialized with `for update` and a payload
  naming a removed id aborts whole — correct, but it means the second tab's work is discarded with
  a generic message.
- **`tests/plans.test.ts` Progress item 1.1 was never run** on S-03 (no Docker on the implementing
  machine), which is why the contract suite is the compensating control. The same caveat applies
  here: if `supabase db reset` cannot be run, Phase 2 is the only evidence the grants took effect.

## Success Criteria (Summary)

- The owner can find every plan they have saved, refine one without losing what the model wrote,
  and remove the ones they no longer want.
- No edit can empty a plan, orphan a rank, or reach another company's data — proven by SQLSTATE in
  `npm run test:remote`, not by an empty result.
- The four plan tables remain unwritable by any path other than the two RPCs, and `anon` holds
  nothing on either.
