'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import type { ActionPlanDetail } from '@/lib/dal'
import type { PlanOriginal } from '@/lib/plan-schema'

import { deletePlan } from '../actions'
import { PlanEditor } from './plan-editor'

/**
 * The plan itself, without the dates — those arrive already formatted (see
 * page.tsx), because this component renders on the client too and
 * `Intl.DateTimeFormat` without an explicit timeZone resolves against the
 * ambient zone, which differs between the two.
 */
export type PlanDetailData = Pick<ActionPlanDetail, 'id' | 'summary' | 'problems'>

/**
 * Which of the three faces of a saved plan is on screen.
 *
 * One piece of state rather than two booleans: the editor and the original are
 * mutually exclusive by construction, and a pair of flags would allow a fourth
 * state that means nothing.
 */
type View = 'read' | 'edit' | 'original'

/**
 * The saved plan and everything the owner can do to it (FR-013, FR-014).
 *
 * A client component wrapping content the server fetched. The split is
 * deliberate: page.tsx stays the fetch + 404 boundary it has been since S-03 —
 * including its no-oracle guarantee — and this component owns nothing but which
 * view is showing. The plan's data never round-trips through the client to be
 * displayed; only an EDIT posts anything back.
 */
export function PlanDetail({
  plan,
  createdAt,
  updatedAt,
  edited,
  original,
}: {
  plan: PlanDetailData
  /** Server-formatted, for display. */
  createdAt: string
  /** Server-formatted. Equal to createdAt until the plan is first edited. */
  updatedAt: string
  /**
   * `original_content is not null` — the same single flag the database uses as
   * its write-once guard and the index uses for its "Edited" badge, so the two
   * surfaces cannot disagree.
   *
   * Separate from `original` below because the two can legitimately diverge:
   * a snapshot that fails to parse leaves `original` null, and reading that as
   * "never edited" would be a lie about what the owner did.
   */
  edited: boolean
  /**
   * What the model produced, parsed out of action_plans.original_content by the
   * page. Null when there is nothing to show — either the plan has never been
   * edited, or the stored snapshot did not parse.
   */
  original: PlanOriginal | null
}) {
  const [view, setView] = useState<View>('read')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Saved action plan
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Generated on {createdAt}.
          {edited && <> Edited on {updatedAt}.</>}
        </p>
      </div>

      {/* The toolbar is rendered in every view so the owner always has a way
          back out of the one they are in. */}
      <div className="flex flex-wrap items-center gap-2">
        {view === 'read' ? (
          <button
            type="button"
            onClick={() => setView('edit')}
            className="flex h-11 cursor-pointer items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Edit this plan
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setView('read')}
            className="flex h-11 cursor-pointer items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            {view === 'edit' ? 'Stop editing' : 'Back to the current plan'}
          </button>
        )}

        {/* Only offered once there IS an original. A plan that has never been
            edited is its own original, and a toggle showing the same text twice
            would say otherwise. */}
        {edited && view !== 'original' && (
          <button
            type="button"
            onClick={() => setView('original')}
            className="flex h-11 cursor-pointer items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            View the original
          </button>
        )}

        <DeletePlanButton id={plan.id} />
      </div>

      {view === 'edit' ? (
        <PlanEditor plan={plan} onDone={() => setView('read')} />
      ) : view === 'original' ? (
        <OriginalView original={original} />
      ) : (
        <ReadView plan={plan} />
      )}
    </div>
  )
}

/**
 * The plan as it stands, read-only — the S-03 page's markup, moved rather than
 * rewritten.
 */
function ReadView({ plan }: { plan: PlanDetailData }) {
  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Summary
        </h2>
        {/* The generated content is Polish; the chrome around it is English.
            lang="pl" tells a screen reader to switch voices rather than read
            Polish with English pronunciation rules — the same split the review
            screen makes. It stays on generated text even after an edit: the
            owner is correcting the model's Polish, not replacing it with
            English. */}
        <p
          lang="pl"
          className="text-sm whitespace-pre-line text-black dark:text-zinc-50"
        >
          {plan.summary}
        </p>
      </div>

      <ol className="flex flex-col gap-4">
        {plan.problems.map((problem) => (
          <li
            key={problem.id}
            className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex items-baseline gap-2">
              {/* The stored `rank`, not the array position: rank is what
                  save_action_plan() persisted and update_action_plan()
                  re-derived, and showing the position instead would silently
                  re-number the plan if a row ever went missing. */}
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                #{problem.rank}
              </span>
              <h3
                lang="pl"
                className="text-sm font-semibold text-black dark:text-zinc-50"
              >
                {problem.title}
              </h3>
            </div>

            <p lang="pl" className="text-sm text-zinc-700 dark:text-zinc-300">
              {problem.rationale}
            </p>

            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                {problem.citations.length === 1
                  ? 'Based on 1 submission'
                  : `Based on ${problem.citations.length} submissions`}
              </h4>
              {problem.citations.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {problem.citations.map((citation) => (
                    <li
                      key={citation.id}
                      className="border-l-2 border-zinc-300 pl-3 text-sm text-zinc-600 italic dark:border-zinc-700 dark:text-zinc-400"
                    >
                      {/* lang is unset on purpose: this is the customer's own
                          text, and the app does not know what language they
                          wrote in. */}
                      {citation.content}
                    </li>
                  ))}
                </ul>
              ) : (
                // Not an error state. Citations cascade away when the owner
                // deletes a submission (FR-009), so a saved problem can end up
                // with none — the plan records what was true when it was
                // generated, and saying so beats rendering a heading over
                // nothing. Editing never removes them: update_action_plan()
                // does not touch plan_problem_submissions.
                <p className="text-sm text-zinc-500 dark:text-zinc-500">
                  The submissions behind this problem have since been deleted.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                What to do
              </h4>
              <ol
                lang="pl"
                className="flex list-decimal flex-col gap-1 pl-5 text-sm text-black dark:text-zinc-50"
              >
                {problem.actions.map((action) => (
                  <li key={action.id}>{action.content}</li>
                ))}
              </ol>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * What the model wrote before the owner's first edit.
 *
 * A thing to READ, not a thing to restore — the roadmap asks that editing not
 * erase what the model gave ("pozadane zachowanie oryginalu generacji"), and
 * reading satisfies that. There is no citation here and no id: restoring would
 * need the evidence rows back too, and those are still attached to the problems
 * that survived.
 */
function OriginalView({ original }: { original: PlanOriginal | null }) {
  if (!original) {
    // Only reachable if the stored snapshot failed PlanOriginalSchema on the
    // server — a plan whose original cannot be parsed still has to render.
    return (
      <p className="rounded-2xl border border-dashed border-zinc-300 p-8 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
        The original version of this plan could not be read.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-dashed border-zinc-300 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-950">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        This is the plan as it was first generated, kept so your edits never
        erase what the model produced. It is a record, not a backup — it cannot
        be restored, and it does not change when you edit again.
      </p>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Summary
        </h2>
        <p
          lang="pl"
          className="text-sm whitespace-pre-line text-black dark:text-zinc-50"
        >
          {original.summary}
        </p>
      </div>

      <ol className="flex flex-col gap-4">
        {original.problems.map((problem, index) => (
          <li
            // The snapshot carries no ids by design, so the index is the only
            // key available. It is stable here in the way it is not in an
            // editable list: this collection never reorders and never changes.
            key={index}
            className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                #{index + 1}
              </span>
              <h3
                lang="pl"
                className="text-sm font-semibold text-black dark:text-zinc-50"
              >
                {problem.title}
              </h3>
            </div>

            <p lang="pl" className="text-sm text-zinc-700 dark:text-zinc-300">
              {problem.rationale}
            </p>

            <ol
              lang="pl"
              className="flex list-decimal flex-col gap-1 pl-5 text-sm text-black dark:text-zinc-50"
            >
              {problem.actions.map((action, actionIndex) => (
                <li key={actionIndex}>{action}</li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The two-step delete, as PlanRow arms it on the index — with one difference
 * that is the whole reason this is a copy rather than a shared component: this
 * one posts `redirectTo`, because the page cannot stay on a route that now
 * 404s.
 *
 * There is no live region and no onDeleted callback here for the same reason:
 * a successful delete navigates away, so there is nothing left on this page to
 * announce it to. Only a failure ever renders below.
 */
function DeletePlanButton({ id }: { id: string }) {
  const [armed, setArmed] = useState(false)
  const [state, action, pending] = useActionState(deletePlan, undefined)

  const deleteRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasArmed = useRef(false)

  // Arming swaps the focused Delete button out of the DOM, which drops focus to
  // <body> and strands a keyboard user at the top of the page. Move focus
  // deliberately in both directions instead — and to Cancel rather than
  // Confirm, so a held Enter key cannot arm and delete in one gesture.
  useEffect(() => {
    if (armed && !wasArmed.current) {
      cancelRef.current?.focus()
    } else if (!armed && wasArmed.current) {
      deleteRef.current?.focus()
    }
    wasArmed.current = armed
  }, [armed])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {armed ? (
          // aria-describedby sits on the form so BOTH buttons inherit it:
          // focus moves to Cancel on arming, and putting the description only
          // on Confirm would leave the focused button undescribed.
          <form
            action={action}
            aria-describedby={`delete-plan-prompt-${id}`}
            className="flex items-center gap-2"
          >
            <input type="hidden" name="id" value={id} />
            {/* The literal the action matches. Anything else is ignored and
                the delete simply stays put — see DELETE_PLAN_REDIRECT. */}
            <input type="hidden" name="redirectTo" value="/dashboard/plans" />

            <button
              type="submit"
              disabled={pending}
              aria-describedby={`delete-plan-prompt-${id}`}
              className="flex h-11 cursor-pointer items-center justify-center rounded-full bg-red-600 px-5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Deleting…' : 'Confirm'}
            </button>

            <button
              ref={cancelRef}
              type="button"
              onClick={() => setArmed(false)}
              disabled={pending}
              aria-describedby={`delete-plan-prompt-${id}`}
              className="flex h-11 cursor-pointer items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-white/[.06]"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            ref={deleteRef}
            type="button"
            onClick={() => setArmed(true)}
            className="flex h-11 cursor-pointer items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium text-zinc-600 transition-colors hover:bg-black/[.04] dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-white/[.06]"
          >
            Delete this plan
          </button>
        )}
      </div>

      {/* Rendered unconditionally, empty when disarmed: a live region has to
          already exist in the DOM before its content changes, or the
          announcement is skipped by several screen-reader/browser pairs. */}
      <p
        id={`delete-plan-prompt-${id}`}
        role="status"
        className="text-xs text-red-700 empty:hidden dark:text-red-400"
      >
        {armed ? 'Delete this plan permanently? This cannot be undone.' : ''}
      </p>

      {/* Only reachable on failure — a successful delete redirects out of this
          route before anything here can render. */}
      {state?.message && (
        <p aria-live="polite" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}
    </div>
  )
}
