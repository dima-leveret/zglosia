'use client'

import { useCallback, useRef, useState } from 'react'

import type { SubmissionListRow } from '@/lib/dal'

import { SUBMISSION_DELETED } from './messages'
import { SubmissionRow } from './submission-row'

/**
 * A row with its date already formatted. Formatting happens on the server (see
 * page.tsx) and arrives here as a string on purpose: this component renders on
 * both server and client, and `Intl.DateTimeFormat` without an explicit
 * timeZone resolves against the ambient zone — which differs between the two
 * and would produce a hydration mismatch, or worse, two different days for the
 * same row.
 */
export type SubmissionListItem = Pick<
  SubmissionListRow,
  'id' | 'content' | 'source'
> & {
  /** ISO 8601, for the <time> element's machine-readable value. */
  isoDate: string
  /** Server-formatted, for display. */
  formattedDate: string
}

/**
 * The source badge is the visible half of FR-008. It is not decoration: the
 * owner needs to know whose voice they are reading — a customer's own words or
 * their own paraphrase — before they act on it. The database guarantees the
 * value is honest; this shows it.
 */
function SourceBadge({ source }: { source: SubmissionListItem['source'] }) {
  const manual = source === 'manual'

  return (
    <span
      className={
        manual
          ? 'rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
          : 'rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
      }
    >
      {manual ? 'Added manually' : 'From form'}
    </span>
  )
}

/**
 * List of submissions, newest first.
 *
 * A client component, unlike the page above it, for one reason: the live region
 * and focus anchor used after a delete must OUTLIVE the row that was deleted.
 * A confirmed delete revalidates, the row unmounts, and anything the row owned
 * — its focus target, its announcement — goes with it, leaving focus on <body>
 * at the top of the page. Both therefore live here.
 *
 * Long content wraps rather than truncating — capped at 2000 characters, the
 * full text is short enough to read in place, and a truncated complaint is one
 * the owner has to click to understand.
 */
export function SubmissionList({
  submissions,
}: {
  submissions: SubmissionListItem[]
}) {
  const [status, setStatus] = useState('')
  const statusRef = useRef<HTMLParagraphElement>(null)

  // Stable identity: the row depends on this in an effect, and a fresh function
  // each render would let that effect re-fire and steal focus back mid-typing.
  const handleDeleted = useCallback(() => {
    setStatus(SUBMISSION_DELETED)
    // Focus a stable element outside the removed row. Focusing the live region
    // itself does double duty: it rescues focus AND gets the message read, so
    // the outcome is announced even where a polite region would be missed.
    statusRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-3">
      {/* Always present, empty until something happens — a live region has to
          exist in the DOM before its content changes to be announced reliably. */}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="text-sm text-zinc-600 outline-none empty:hidden dark:text-zinc-400"
      >
        {status}
      </p>

      <ul className="flex flex-col gap-3">
        {submissions.map((submission) => (
          <SubmissionRow
            key={submission.id}
            id={submission.id}
            onDeleted={handleDeleted}
          >
            <div className="flex items-center gap-2">
              <SourceBadge source={submission.source} />
              <time
                dateTime={submission.isoDate}
                className="text-xs text-zinc-500 dark:text-zinc-500"
              >
                {submission.formattedDate}
              </time>
            </div>
            <p className="text-sm whitespace-pre-wrap break-words text-black dark:text-zinc-50">
              {submission.content}
            </p>
          </SubmissionRow>
        ))}
      </ul>
    </div>
  )
}
