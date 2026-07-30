'use client'

import { useEffect } from 'react'

/**
 * Error boundary for every /dashboard route.
 *
 * getCompany() rethrows any Supabase error rather than swallowing it, which is
 * the right call — a read that silently returns null would render an empty
 * profile as if it were a blank one. But without a boundary that throw reaches
 * the framework's generic 500 page, which offers the owner nothing to do. A
 * dashboard read failure is usually transient, so a retry is the whole fix.
 *
 * `unstable_retry`, not `reset`: this fork's docs (file-conventions/error.md,
 * prop added in v16.2.0) note that `reset()` clears the error state and
 * re-renders WITHOUT re-fetching, which would replay the same failed read.
 * `unstable_retry()` re-fetches the segment, which is the only thing that can
 * actually recover a transient database error.
 *
 * The error message is deliberately not rendered: it comes from the database
 * driver and is not something to put in front of an owner.
 */
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error('dashboard route error:', error)
  }, [error])

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          We could not load your dashboard. This is usually temporary — try
          again.
        </p>
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Try again
        </button>
      </div>
    </main>
  )
}
