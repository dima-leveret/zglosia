import Link from 'next/link'

import { getCompany, getSubmissions } from '@/lib/dal'
import { SUBMISSION_LIST_LIMIT } from '@/lib/list-limits'

import { SubmissionForm } from './submission-form'
import { SubmissionList, type SubmissionListItem } from './submission-list'

/**
 * Fixed locale rather than the ambient one, and applied here on the server
 * rather than in the list: the list is a client component, so formatting there
 * would run in the browser's zone on hydration and the server's zone on render
 * — two different days for the same row near midnight. Formatting once, up
 * here, keeps a single answer.
 */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * The submissions surface (FR-007, FR-008). Lives under /dashboard so the
 * existing PROTECTED_PREFIXES guard in src/proxy.ts covers it with no config
 * change; verifySession() inside the DAL is the actual boundary.
 */
export default async function SubmissionsPage() {
  // Both reads are independent, so they overlap rather than queue. verifySession
  // is cache()d, so the two getUser() calls dedupe to one round trip.
  const [company, { submissions, total }] = await Promise.all([
    getCompany(),
    getSubmissions(),
  ])

  const items: SubmissionListItem[] = submissions.map((submission) => ({
    id: submission.id,
    content: submission.content,
    source: submission.source,
    isoDate: submission.created_at,
    formattedDate: dateFormatter.format(new Date(submission.created_at)),
  }))

  return (
    <main className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="text-sm text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            ← Back to dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Submissions
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Everything your customers have told you. Action plans are generated
            from these.
          </p>
        </div>

        {!company ? (
          // Same branch both sibling pages render. Without it the owner gets a
          // friendly empty state and a form that looks like it works, then a
          // generic failure on submit — RLS returns nothing for a NULL
          // current_company_id(), so the page cannot tell "no submissions" from
          // "no tenant" unless it asks.
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No company is provisioned for this account yet.
          </p>
        ) : (
          <>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <SubmissionForm />
        </div>

        {total > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {total === 1 ? '1 submission' : `${total} submissions`}
              </h2>
              {/* Explicit rather than silently truncating: the owner should
                  never be told a number the list below does not contain. */}
              {total > SUBMISSION_LIST_LIMIT && (
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                  Showing the latest {SUBMISSION_LIST_LIMIT} of {total}
                </p>
              )}
            </div>
            <SubmissionList submissions={items} />
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
            <p className="text-sm font-medium text-black dark:text-zinc-50">
              No submissions yet.
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Add what customers tell you — in person, by phone, however it
              reaches you. Once there are a few, you can generate an action plan
              from them.
            </p>
          </div>
        )}
          </>
        )}
      </div>
    </main>
  )
}
