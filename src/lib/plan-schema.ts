import { z } from 'zod'

import { SUBMISSION_LIST_LIMIT } from '@/lib/dal'

/**
 * The shape the model must return, and the step that turns it into something
 * safe to save (S-03, FR-011).
 *
 * This module is deliberately pure — no Supabase client, no `server-only`, no
 * network. Everything here is unit-testable without spending a token, which is
 * the point: the citation-resolution step below is what carries the
 * anti-hallucination NFR on the application side, and a guarantee that can only
 * be exercised by paying a model is a guarantee nobody re-runs.
 */

/**
 * String bounds. Each one mirrors a CHECK constraint from
 * 20260814132833_generate_action_plan.sql exactly. They are duplicated here
 * rather than derived because the two enforce different things at different
 * moments: the CHECK is the boundary (a direct PostgREST call skips Zod
 * entirely), while this copy makes an over-long field fail at GENERATION time,
 * where the owner can simply press the button again — instead of at save time,
 * after they have already read and accepted a plan they then cannot keep.
 *
 * Change these and the migration's CHECKs together.
 */
export const PLAN_SUMMARY_MAX = 4000
export const PROBLEM_TITLE_MAX = 200
export const PROBLEM_RATIONALE_MAX = 2000
export const ACTION_CONTENT_MAX = 1000

/**
 * Collection bounds. Unlike the string caps above these have no database
 * counterpart — they are product judgements about what an owner can act on.
 *
 * The citation cap is the one worth explaining: it is a UI bound, not a data
 * bound. The review screen shows every cited submission verbatim, because
 * showing a problem without the customer words behind it is exactly the
 * "another statistics tool" the roadmap says this product must not be. Forty
 * quotes under one heading is not evidence, it is a wall.
 */
export const PLAN_PROBLEMS_MIN = 1
export const PLAN_PROBLEMS_MAX = 8
export const PROBLEM_ACTIONS_MIN = 1
export const PROBLEM_ACTIONS_MAX = 5
export const PROBLEM_CITATIONS_MIN = 1
export const PROBLEM_CITATIONS_MAX = 10

/**
 * A required, non-blank, bounded string as the model must produce it.
 *
 * `.trim()` runs before the length checks for the same reason it does in
 * validation.ts, and it also lines the schema up with the migration's
 * `~ '[^[:space:]]'` CHECK: a whitespace-only title passes `maxLength` and then
 * fails at save time, which is the failure ordering this module exists to
 * avoid.
 */
const modelText = (max: number) => z.string().trim().min(1).max(max)

/**
 * The structured output contract handed to the model.
 *
 * `submissionIndexes` carries the load-bearing design decision in this file:
 * the model is shown a NUMBERED list of submissions and returns positions in
 * it, never uuids. A model asked to echo a uuid corrupts it character by
 * character and the corruption is undetectable without a lookup; a small
 * integer is something models get right, and anything outside the range is
 * trivially checkable. Indexes are 1-based to match the list the prompt
 * renders — a numbered list starting at 0 invites off-by-one output, and 0 is
 * also what an absent number coerces to.
 *
 * The upper bound is SUBMISSION_LIST_LIMIT because that is the largest list the
 * prompt can ever present (dal.ts caps the read at 100). It is a sanity bound
 * on the JSON Schema, not the real check — resolveCitations() below validates
 * against the actual list length, which is usually far smaller.
 */
export const PlanOutputSchema = z.object({
  summary: modelText(PLAN_SUMMARY_MAX),
  problems: z
    .array(
      z.object({
        title: modelText(PROBLEM_TITLE_MAX),
        rationale: modelText(PROBLEM_RATIONALE_MAX),
        submissionIndexes: z
          .array(z.int().min(1).max(SUBMISSION_LIST_LIMIT))
          .min(PROBLEM_CITATIONS_MIN)
          .max(PROBLEM_CITATIONS_MAX),
        actions: z
          .array(modelText(ACTION_CONTENT_MAX))
          .min(PROBLEM_ACTIONS_MIN)
          .max(PROBLEM_ACTIONS_MAX),
      })
    )
    .min(PLAN_PROBLEMS_MIN)
    .max(PLAN_PROBLEMS_MAX),
})

/** The model's raw output, indexes still unresolved. */
export type PlanOutput = z.infer<typeof PlanOutputSchema>

/**
 * One problem after its indexes have been resolved to real submission ids.
 *
 * The key names are not free: they are exactly the element keys
 * `save_action_plan(p_summary, p_problems)` reads out of its jsonb argument
 * (`title`, `rationale`, `submissionIds`, `actions`), so the save path can hand
 * this array straight to the RPC without a translation layer that could drift.
 */
export type VerifiedProblem = {
  title: string
  rationale: string
  /** Real submissions.id values, deduplicated, in the model's cited order. */
  submissionIds: string[]
  actions: string[]
}

/**
 * A plan whose every citation resolves to a submission that was actually in the
 * prompt. Array order IS the priority order — the RPC assigns `rank` from the
 * position rather than trusting a field, so there is nothing to keep in sync.
 */
export type VerifiedPlan = {
  summary: string
  problems: VerifiedProblem[]
}

/**
 * The same plan as it comes BACK over the wire, when the owner presses Save.
 *
 * The plan travels twice — out to the review screen, then back to savePlan —
 * and this schema is what makes that round trip safe to parse rather than safe
 * to trust. It checks STRUCTURE and BOUNDS only. It deliberately does not, and
 * could not, check grounding: `submissionIds` is validated as uuid-shaped and
 * nothing more, because whether a uuid names a submission of the caller's own
 * company is a question only the database can answer. `save_action_plan()`
 * answers it inside the transaction and aborts on any id that does not resolve.
 *
 * Typed as `z.ZodType<VerifiedPlan>` rather than left to inference: that
 * annotation is a compile-time check that the wire shape and the in-memory
 * shape cannot drift apart, and it is also what lets the save path hand
 * `parsed.data.problems` straight to the RPC's jsonb argument.
 */
export const VerifiedPlanSchema: z.ZodType<VerifiedPlan> = z.object({
  summary: modelText(PLAN_SUMMARY_MAX),
  problems: z
    .array(
      z.object({
        title: modelText(PROBLEM_TITLE_MAX),
        rationale: modelText(PROBLEM_RATIONALE_MAX),
        // Bounded by the same citation cap the model works under. A payload
        // carrying 500 ids for one problem is not a plan this app produced, and
        // the RPC would loop over every one of them before refusing.
        submissionIds: z
          .array(z.uuid())
          .min(PROBLEM_CITATIONS_MIN)
          .max(PROBLEM_CITATIONS_MAX),
        actions: z
          .array(modelText(ACTION_CONTENT_MAX))
          .min(PROBLEM_ACTIONS_MIN)
          .max(PROBLEM_ACTIONS_MAX),
      })
    )
    .min(PLAN_PROBLEMS_MIN)
    .max(PLAN_PROBLEMS_MAX),
})

/**
 * One action of a plan the OWNER is editing (S-04, FR-014).
 *
 * `id` is what makes an edit an edit. save_action_plan() posts new rows and
 * needs no ids; update_action_plan() is handed the whole desired state and
 * decides removal by absence, so every surviving row has to name itself.
 */
export type PlanEditAction = {
  id: string
  content: string
}

/** One problem of a plan being edited, with the actions it keeps. */
export type PlanEditProblem = {
  id: string
  title: string
  rationale: string
  actions: PlanEditAction[]
}

/**
 * A whole saved plan as the owner wants it to be.
 *
 * The key names are not free, exactly as VerifiedProblem's are not: they are
 * the element keys `update_action_plan(p_plan_id, p_summary, p_problems)` reads
 * out of its jsonb argument (`id`, `title`, `rationale`, `actions[].id`,
 * `actions[].content`), so the update path hands `parsed.data.problems` straight
 * to the RPC with no translation layer that could drift.
 *
 * `submissionIds` is deliberately ABSENT. Editing never touches
 * plan_problem_submissions — the citations are the evidence, and the edit
 * rewrites the words around them — and accepting the field even to ignore it
 * would suggest otherwise to the next reader.
 *
 * Array order IS the priority order. `rank` and `position` are assigned from
 * the position in the array inside the RPC and never read from the payload, so
 * there is no ordering field here to keep in sync.
 */
export type PlanEdit = {
  summary: string
  problems: PlanEditProblem[]
}

/**
 * The edit payload as it comes back over the wire.
 *
 * Same posture as VerifiedPlanSchema: STRUCTURE and BOUNDS only. It checks that
 * every id is uuid-shaped and nothing more, because whether a uuid names a
 * problem of THIS plan — or of this company's plan at all — is a question only
 * the database can answer. update_action_plan() answers it inside the
 * transaction and aborts on any id that does not resolve.
 *
 * Its job here is failure ORDERING, not safety: without it a malformed body
 * reaches PostgREST and comes back as a raw `22P02` (invalid input syntax for
 * uuid), which the Server Action would then have to translate. One logged parse
 * failure is cheaper and says more.
 *
 * The bounds are the same constants the RPC's own floors and ceilings mirror,
 * and the same ones the editor's `maxLength` attributes read — three copies of
 * one number, which is why they are exported rather than inlined.
 */
export const PlanEditSchema: z.ZodType<PlanEdit> = z.object({
  summary: modelText(PLAN_SUMMARY_MAX),
  problems: z
    .array(
      z.object({
        id: z.uuid(),
        title: modelText(PROBLEM_TITLE_MAX),
        rationale: modelText(PROBLEM_RATIONALE_MAX),
        actions: z
          .array(
            z.object({
              id: z.uuid(),
              content: modelText(ACTION_CONTENT_MAX),
            })
          )
          .min(PROBLEM_ACTIONS_MIN)
          .max(PROBLEM_ACTIONS_MAX),
      })
    )
    .min(PLAN_PROBLEMS_MIN)
    .max(PLAN_PROBLEMS_MAX),
})

/**
 * The snapshot of what the model originally produced, as stored in
 * action_plans.original_content.
 *
 * Flat text, no ids: it is a thing to READ, not a thing to restore. The roadmap
 * asks that editing not erase what the model gave ("pożądane zachowanie
 * oryginału generacji"), and reading is what satisfies that — restoring would
 * need the citations back too, and those belong to the rows that are still
 * there.
 */
export type PlanOriginal = {
  summary: string
  problems: {
    title: string
    rationale: string
    actions: string[]
  }[]
}

/**
 * The snapshot re-parsed on the way out.
 *
 * The column is jsonb with only a shallow `jsonb_typeof(...) = 'object'` CHECK
 * behind it, so the generated types can say no more than "some json". Parsing
 * rather than casting is what keeps a render of the original from throwing on
 * `.map` of undefined.
 *
 * Bounds are deliberately NOT re-applied. update_action_plan() builds this value
 * from stored rows that already passed the table CHECKs, so a length rule here
 * could only ever reject a legitimate snapshot — and a plan whose original
 * cannot be shown is worse than one whose original is a little long.
 */
export const PlanOriginalSchema: z.ZodType<PlanOriginal> = z.object({
  summary: z.string(),
  problems: z.array(
    z.object({
      title: z.string(),
      rationale: z.string(),
      actions: z.array(z.string()),
    })
  ),
})

/**
 * What resolveCitations() found. The drop lists exist so the caller can log
 * what the model got wrong — silently discarding a hallucinated citation and
 * saying nothing is how a model that has started inventing evidence stays
 * invisible.
 */
export type CitationResolution = {
  /**
   * The verified plan, or null when every problem was dropped. Null is not an
   * empty plan: a plan with zero problems is not a plan, so the caller must
   * treat it as a failed generation rather than showing the owner a blank one.
   */
  plan: VerifiedPlan | null
  /** Indexes the model cited that were outside the list it was shown. */
  droppedIndexes: number[]
  /** Titles of problems that lost every citation and were removed. */
  droppedProblems: string[]
}

/**
 * Resolves the model's 1-based indexes back to real submission ids, dropping
 * anything that does not resolve.
 *
 * THIS IS THE ANTI-HALLUCINATION NFR ON THE APPLICATION SIDE. A problem that
 * survives here cites at least one submission the owner genuinely has, because
 * the ids come out of `submissionIds` — the exact list handed to the prompt —
 * and never out of the model's response.
 *
 * It is the FIRST of two independent layers, not the only one.
 * `save_action_plan()` re-checks every id against the caller's own submissions
 * inside the transaction and aborts on any that does not resolve, which is what
 * holds when the plan is posted back by something other than this code.
 *
 * @param submissionIds the ids of the submissions the prompt rendered, in the
 *   same order the prompt numbered them. Index 1 is `submissionIds[0]`.
 */
export function resolveCitations(
  output: PlanOutput,
  submissionIds: readonly string[]
): CitationResolution {
  const droppedIndexes: number[] = []
  const droppedProblems: string[] = []
  const problems: VerifiedProblem[] = []

  for (const problem of output.problems) {
    // A Set, not a filter: a model that cites the same submission twice is
    // sloppy rather than ungrounded, and the review screen would otherwise
    // render the same quote under one problem twice.
    const ids = new Set<string>()

    for (const index of problem.submissionIndexes) {
      const id = submissionIds[index - 1]

      if (id === undefined) {
        droppedIndexes.push(index)
        continue
      }

      ids.add(id)
    }

    if (ids.size === 0) {
      droppedProblems.push(problem.title)
      continue
    }

    problems.push({
      title: problem.title,
      rationale: problem.rationale,
      submissionIds: [...ids],
      actions: problem.actions,
    })
  }

  return {
    plan: problems.length > 0 ? { summary: output.summary, problems } : null,
    droppedIndexes,
    droppedProblems,
  }
}
