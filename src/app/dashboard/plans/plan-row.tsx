'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import { deletePlan } from './actions'
import { PLAN_DELETED } from './messages'

/**
 * One row of the saved-plans index, plus the only client state the list needs:
 * whether this row is armed for deletion.
 *
 * A structural copy of SubmissionRow rather than a shared abstraction. The two
 * differ where it matters — a plan row links onward, a submission row does not,
 * and the plan's own page arms the same delete with a redirect this row must
 * not have — so the shared version would be a component configured by three
 * booleans, which is harder to read than either copy.
 *
 * The state is per-row on purpose: arming one row must never arm another. The
 * presentational content is passed in as children so the dates inside it stay
 * server-formatted (see plan-list.tsx).
 *
 * Inline two-step rather than confirm() or type-to-confirm. A plan is
 * regenerable from the submissions it came from; the account-deletion gate is
 * type-to-confirm because that one is not.
 */
export function PlanRow({
  id,
  children,
  onDeleted,
}: {
  id: string
  children: React.ReactNode
  /**
   * Called after a delete succeeds, so the list can move focus and announce the
   * removal. Both have to happen above this component: the row unmounts on
   * revalidation, taking any focus target or live region inside it along.
   */
  onDeleted: () => void
}) {
  const [armed, setArmed] = useState(false)
  const [state, action, pending] = useActionState(deletePlan, undefined)

  const deleteRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const wasArmed = useRef(false)

  // Arming swaps the focused Delete button out of the DOM, which drops focus to
  // <body> and strands a keyboard user at the top of the page. Move focus
  // deliberately in both directions instead.
  //
  // Cancel gets focus rather than Confirm: the button that just appeared under
  // the user's finger should not be the destructive one, or a held Enter key
  // arms and deletes in a single gesture.
  useEffect(() => {
    if (armed && !wasArmed.current) {
      cancelRef.current?.focus()
    } else if (!armed && wasArmed.current) {
      deleteRef.current?.focus()
    }
    wasArmed.current = armed
  }, [armed])

  // Hand off to the list on success. This effect may well run in the same pass
  // that unmounts the row — which is exactly why the focus target and the
  // announcement it triggers live in the parent rather than here.
  useEffect(() => {
    if (state?.message === PLAN_DELETED) {
      onDeleted()
    }
  }, [state, onDeleted])

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      {children}

      {/* Rendered unconditionally, empty when disarmed. A live region has to
          already exist in the DOM before its content changes — one inserted
          together with its text is skipped by several screen-reader/browser
          pairs, which would make the announcement this element exists for
          silently unreliable. */}
      <p
        id={`delete-plan-prompt-${id}`}
        role="status"
        className="text-xs text-red-700 empty:hidden dark:text-red-400"
      >
        {armed ? 'Delete this plan permanently? This cannot be undone.' : ''}
      </p>

      <div className="flex items-center gap-2">
        {armed ? (
          // aria-describedby sits on the form so BOTH buttons inherit it.
          // Putting it only on Confirm left the described control unreachable:
          // focus moves to Cancel on arming, so the user landed on a button
          // with no description at all.
          <form
            action={action}
            aria-describedby={`delete-plan-prompt-${id}`}
            className="flex items-center gap-2"
          >
            <input type="hidden" name="id" value={id} />
            {/* No redirectTo: a list row deletes in place. The plan's own page
                posts one, because it cannot stay on a route that now 404s. */}

            <button
              type="submit"
              disabled={pending}
              aria-describedby={`delete-plan-prompt-${id}`}
              className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Deleting…' : 'Confirm'}
            </button>

            <button
              ref={cancelRef}
              type="button"
              onClick={() => setArmed(false)}
              disabled={pending}
              aria-describedby={`delete-plan-prompt-${id}`}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-white/[.06]"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            ref={deleteRef}
            type="button"
            onClick={() => setArmed(true)}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[.04] dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-white/[.06]"
          >
            Delete
          </button>
        )}
      </div>

      {/* Only reachable on failure — on success the row is gone with the
          revalidation. */}
      {state?.message && (
        <p aria-live="polite" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </p>
      )}
    </li>
  )
}
