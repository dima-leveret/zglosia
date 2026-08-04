import type { SubmissionListRow } from '@/lib/dal'

import { SubmissionRow } from './submission-row'

/**
 * Fixed locale rather than the ambient one: this renders on the server, and an
 * implicit locale would make the output depend on where it happens to run.
 * "4 Aug 2026" is unambiguous in a way that any all-numeric format is not.
 */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * The source badge is the visible half of FR-008. It is not decoration: the
 * owner needs to know whose voice they are reading — a customer's own words or
 * their own paraphrase — before they act on it. The database guarantees the
 * value is honest; this shows it.
 */
function SourceBadge({ source }: { source: SubmissionListRow['source'] }) {
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
 * List of submissions, newest first. Stays a server component: only the delete
 * control needs client state, so only that row wrapper is a client component.
 * The badge, the date and the content are rendered here and handed down as
 * children, which keeps date formatting on the server.
 *
 * Long content wraps rather than truncating — capped at 2000 characters, the
 * full text is short enough to read in place, and a truncated complaint is one
 * the owner has to click to understand.
 */
export function SubmissionList({
  submissions,
}: {
  submissions: SubmissionListRow[]
}) {
  return (
    <ul className="flex flex-col gap-3">
      {submissions.map((submission) => (
        <SubmissionRow key={submission.id} id={submission.id}>
          <div className="flex items-center gap-2">
            <SourceBadge source={submission.source} />
            <time
              dateTime={submission.created_at}
              className="text-xs text-zinc-500 dark:text-zinc-500"
            >
              {dateFormatter.format(new Date(submission.created_at))}
            </time>
          </div>
          <p className="text-sm whitespace-pre-wrap break-words text-black dark:text-zinc-50">
            {submission.content}
          </p>
        </SubmissionRow>
      ))}
    </ul>
  )
}
