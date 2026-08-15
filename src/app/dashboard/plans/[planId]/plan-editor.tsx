'use client'

import { useActionState, useState } from 'react'

import {
  ACTION_CONTENT_MAX,
  PLAN_SUMMARY_MAX,
  PROBLEM_RATIONALE_MAX,
  PROBLEM_TITLE_MAX,
  type PlanEdit,
} from '@/lib/plan-schema'

import { updatePlan } from '../actions'
import { PLAN_SAVED } from '../messages'
import type { PlanDetailData } from './plan-detail'

/**
 * The whole plan in one editable form (FR-014).
 *
 * CONTROLLED, and that is the load-bearing decision. The largest possible plan
 * is 8 problems x (title + rationale + 5 steps) plus a summary — around fifty
 * fields — and an uncontrolled form of that size would have to echo every value
 * back from the server on a failed save, or the owner's work is erased by
 * React's post-action reset. Holding the plan in state makes the client its own
 * echo, and lets the form post ONE hidden JSON field, exactly as PlanReview
 * already does for savePlan().
 *
 * REMOVALS ARE STAGED, never sent on their own. update_action_plan() takes the
 * whole desired state and treats an absent id as a removal, so dropping a
 * problem here is a local splice and Cancel is a genuine no-op on the database
 * — no undo path to build, because nothing was written.
 *
 * It cannot ADD anything, by design. A problem the owner wrote would cite no
 * submission, putting an ungrounded row into the table whose entire purpose is
 * grounding — so the editor rewrites and removes, and generation is the only
 * thing that creates.
 */
export function PlanEditor({
  plan,
  onDone,
}: {
  plan: PlanDetailData
  /** Leave the editor. Local state goes with it — that IS the cancel. */
  onDone: () => void
}) {
  const [state, action, pending] = useActionState(updatePlan, undefined)

  // Seeded once, from the server's copy of the plan. It deliberately does NOT
  // re-seed when the props change after a successful save: the props are then
  // reporting the state this component just sent, and re-seeding would only
  // matter if it could overwrite unsaved edits.
  const [draft, setDraft] = useState<PlanEdit>(() => ({
    summary: plan.summary,
    problems: plan.problems.map((problem) => ({
      id: problem.id,
      title: problem.title,
      rationale: problem.rationale,
      actions: problem.actions.map((problemAction) => ({
        id: problemAction.id,
        content: problemAction.content,
      })),
    })),
  }))

  // The citations stay OUT of the draft: they are not editable, they are not
  // part of the payload, and update_action_plan() never touches
  // plan_problem_submissions. They are looked up from the server's copy by
  // problem id, so a staged removal takes a problem's evidence off the screen
  // without ever putting it in the edit.
  const citations = new Map(
    plan.problems.map((problem) => [problem.id, problem.citations])
  )

  const saved = state?.message === PLAN_SAVED

  const updateProblem = (
    id: string,
    field: 'title' | 'rationale',
    value: string
  ) =>
    setDraft((current) => ({
      ...current,
      problems: current.problems.map((problem) =>
        problem.id === id ? { ...problem, [field]: value } : problem
      ),
    }))

  const updateAction = (problemId: string, actionId: string, value: string) =>
    setDraft((current) => ({
      ...current,
      problems: current.problems.map((problem) =>
        problem.id === problemId
          ? {
              ...problem,
              actions: problem.actions.map((problemAction) =>
                problemAction.id === actionId
                  ? { ...problemAction, content: value }
                  : problemAction
              ),
            }
          : problem
      ),
    }))

  const removeProblem = (id: string) =>
    setDraft((current) => ({
      ...current,
      problems: current.problems.filter((problem) => problem.id !== id),
    }))

  const removeAction = (problemId: string, actionId: string) =>
    setDraft((current) => ({
      ...current,
      problems: current.problems.map((problem) =>
        problem.id === problemId
          ? {
              ...problem,
              actions: problem.actions.filter(
                (problemAction) => problemAction.id !== actionId
              ),
            }
          : problem
      ),
    }))

  // The floors the RPC raises 22023 on. Checking them here is not duplication
  // for its own sake: a disabled button with a stated reason is feedback the
  // owner can act on, while a generic failure after a save is not. The database
  // check remains the boundary — this one is only the first thing they meet.
  const atProblemFloor = draft.problems.length === 1

  return (
    <form action={action} className="flex flex-col gap-6">
      {/* The plan goes back the way it came, as one field. Not a trust
          boundary: updatePlan() re-parses it and update_action_plan()
          re-verifies every id against this plan inside the transaction. */}
      <input type="hidden" name="planId" value={plan.id} />
      <input type="hidden" name="plan" value={JSON.stringify(draft)} />

      <div className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="plan-summary"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Summary
          </label>
          <textarea
            id="plan-summary"
            lang="pl"
            rows={6}
            // maxLength from the shared constant rather than a literal: the
            // browser cap, the Zod cap and the CHECK constraint are the same
            // number, and a literal in the JSX is how they drift.
            maxLength={PLAN_SUMMARY_MAX}
            value={draft.summary}
            onChange={(event) =>
              setDraft((current) => ({ ...current, summary: event.target.value }))
            }
            className="rounded-lg border border-zinc-300 bg-transparent p-3 text-sm text-black dark:border-zinc-700 dark:text-zinc-50"
          />
        </div>

        <ol className="flex flex-col gap-4">
          {draft.problems.map((problem, index) => {
            const atActionFloor = problem.actions.length === 1
            const problemCitations = citations.get(problem.id) ?? []

            return (
              <li
                key={problem.id}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="flex items-baseline justify-between gap-2">
                  {/* The ARRAY POSITION here, not the stored rank: removals are
                      staged, and update_action_plan() re-derives rank from
                      array order on save. Showing the stored rank would promise
                      a numbering the save is about to change. */}
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    #{index + 1}
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => removeProblem(problem.id)}
                      disabled={pending || atProblemFloor}
                      aria-describedby={
                        atProblemFloor ? 'plan-problem-floor' : undefined
                      }
                      className="cursor-pointer rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-white/[.06]"
                    >
                      Remove this problem
                    </button>
                    {atProblemFloor && (
                      <span
                        id="plan-problem-floor"
                        className="text-xs text-zinc-500 dark:text-zinc-500"
                      >
                        A plan must keep at least one problem.
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label
                    htmlFor={`problem-title-${problem.id}`}
                    className="text-xs font-medium text-zinc-500 dark:text-zinc-500"
                  >
                    Problem
                  </label>
                  <input
                    id={`problem-title-${problem.id}`}
                    lang="pl"
                    type="text"
                    maxLength={PROBLEM_TITLE_MAX}
                    value={problem.title}
                    onChange={(event) =>
                      updateProblem(problem.id, 'title', event.target.value)
                    }
                    className="rounded-lg border border-zinc-300 bg-transparent p-2 text-sm font-semibold text-black dark:border-zinc-700 dark:text-zinc-50"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label
                    htmlFor={`problem-rationale-${problem.id}`}
                    className="text-xs font-medium text-zinc-500 dark:text-zinc-500"
                  >
                    Why it matters
                  </label>
                  <textarea
                    id={`problem-rationale-${problem.id}`}
                    lang="pl"
                    rows={3}
                    maxLength={PROBLEM_RATIONALE_MAX}
                    value={problem.rationale}
                    onChange={(event) =>
                      updateProblem(problem.id, 'rationale', event.target.value)
                    }
                    className="rounded-lg border border-zinc-300 bg-transparent p-2 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                  />
                </div>

                {/* Read-only, and present for a reason: the owner is rewriting
                    the model's words about what customers said, and the
                    customers' own words belong in front of them while they do
                    it — the same argument the citation cap in plan-schema.ts
                    makes for the review screen. */}
                <div className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    {problemCitations.length === 1
                      ? 'Based on 1 submission'
                      : `Based on ${problemCitations.length} submissions`}
                  </h4>
                  {problemCitations.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {problemCitations.map((citation) => (
                        <li
                          key={citation.id}
                          className="border-l-2 border-zinc-300 pl-3 text-sm text-zinc-600 italic dark:border-zinc-700 dark:text-zinc-400"
                        >
                          {/* lang unset: the customer's own text, in whatever
                              language they wrote it. */}
                          {citation.content}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-zinc-500 dark:text-zinc-500">
                      The submissions behind this problem have since been
                      deleted.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    What to do
                  </h4>
                  <ol className="flex flex-col gap-3">
                    {problem.actions.map((problemAction, actionIndex) => (
                      <li
                        key={problemAction.id}
                        className="flex flex-col gap-2"
                      >
                        <label
                          htmlFor={`action-${problemAction.id}`}
                          className="text-xs text-zinc-500 dark:text-zinc-500"
                        >
                          Step {actionIndex + 1}
                        </label>
                        <textarea
                          id={`action-${problemAction.id}`}
                          lang="pl"
                          rows={2}
                          maxLength={ACTION_CONTENT_MAX}
                          value={problemAction.content}
                          onChange={(event) =>
                            updateAction(
                              problem.id,
                              problemAction.id,
                              event.target.value
                            )
                          }
                          className="rounded-lg border border-zinc-300 bg-transparent p-2 text-sm text-black dark:border-zinc-700 dark:text-zinc-50"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              removeAction(problem.id, problemAction.id)
                            }
                            disabled={pending || atActionFloor}
                            aria-describedby={
                              atActionFloor
                                ? `action-floor-${problem.id}`
                                : undefined
                            }
                            className="cursor-pointer rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-white/[.06]"
                          >
                            Remove this step
                          </button>
                          {atActionFloor && (
                            <span
                              id={`action-floor-${problem.id}`}
                              className="text-xs text-zinc-500 dark:text-zinc-500"
                            >
                              A problem must keep at least one step.
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </li>
            )
          })}
        </ol>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="flex h-11 cursor-pointer items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-[#ccc]"
          >
            {pending ? 'Saving…' : 'Save changes'}
          </button>

          {/* type="button", and outside nothing: it must never submit. Leaving
              the editor drops the draft, which is the whole cancel — after a
              successful save there is nothing left to drop, which is why the
              label changes rather than the behaviour. */}
          <button
            type="button"
            onClick={onDone}
            disabled={pending}
            className="flex h-11 cursor-pointer items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            {saved ? 'Done' : 'Cancel'}
          </button>
        </div>

        {/* Both outcomes land here, unlike the review screen where only a
            failure can render: this save stays on the page, so a success that
            said nothing would be indistinguishable from a click that did
            nothing. */}
        {state?.message && (
          <p
            aria-live="polite"
            className={
              saved
                ? 'text-sm text-zinc-600 dark:text-zinc-400'
                : 'text-sm text-red-700 dark:text-red-400'
            }
          >
            {state.message}
          </p>
        )}
      </div>
    </form>
  )
}
