'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import { deleteSubmission } from './actions'

/**
 * One list row, plus the only piece of client state this slice needs: whether
 * this row is armed for deletion.
 *
 * The state is per-row on purpose — arming one row must never arm another, so
 * it lives here rather than as an "armedId" on the list. The presentational
 * content (badge, date, text) is passed in as children so it stays rendered on
 * the server: the date in particular must not be formatted on the client, where
 * a different timezone would produce a hydration mismatch.
 *
 * Inline two-step rather than confirm() or type-to-confirm. One submission is
 * recoverable by re-asking the customer; the account-deletion gate is
 * type-to-confirm because that one is not.
 */
export function SubmissionRow({
  id,
  children,
}: {
  id: string
  children: React.ReactNode
}) {
  const [armed, setArmed] = useState(false)
  const [state, action, pending] = useActionState(deleteSubmission, undefined)

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

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      {children}

      <div className="flex items-center gap-2">
        {armed ? (
          <form action={action} className="flex items-center gap-2">
            <input type="hidden" name="id" value={id} />

            {/* Announced because it appears dynamically: a screen-reader user
                must be told the control they are on has become destructive,
                not discover it by pressing it. */}
            <p
              id={`delete-prompt-${id}`}
              role="status"
              className="text-xs text-red-700 dark:text-red-400"
            >
              Delete permanently? This cannot be undone.
            </p>

            <button
              type="submit"
              disabled={pending}
              aria-describedby={`delete-prompt-${id}`}
              className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Deleting…' : 'Confirm'}
            </button>

            <button
              ref={cancelRef}
              type="button"
              onClick={() => setArmed(false)}
              disabled={pending}
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
        <p
          aria-live="polite"
          className="text-sm text-red-700 dark:text-red-400"
        >
          {state.message}
        </p>
      )}
    </li>
  )
}
