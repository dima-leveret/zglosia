import Link from 'next/link'

import { SUBMISSION_LIST_LIMIT, getSubmissions } from '@/lib/dal'

import { SubmissionForm } from './submission-form'
import { SubmissionList } from './submission-list'

/**
 * The submissions surface (FR-007, FR-008). Lives under /dashboard so the
 * existing PROTECTED_PREFIXES guard in src/proxy.ts covers it with no config
 * change; verifySession() inside the DAL is the actual boundary.
 */
export default async function SubmissionsPage() {
  const { submissions, total } = await getSubmissions()

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
            <SubmissionList submissions={submissions} />
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
      </div>
    </main>
  )
}
