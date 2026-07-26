import { getCompany } from '@/lib/dal'

import { logout } from './actions'

/**
 * The isolation proof surface: reads the caller's own company through the DAL
 * (RLS-scoped), so rendering it proves the session and per-owner isolation both
 * work end-to-end. Unauthenticated access is already redirected by the proxy
 * and by verifySession() inside the DAL.
 */
export default async function DashboardPage() {
  const company = await getCompany()

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 dark:bg-black">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Dashboard
        </h1>

        {company ? (
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex flex-col">
              <dt className="text-zinc-500 dark:text-zinc-500">Company name</dt>
              <dd className="text-black dark:text-zinc-50">
                {company.name ?? (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    Not set yet
                  </span>
                )}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-zinc-500 dark:text-zinc-500">Company id</dt>
              <dd className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {company.id}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No company is provisioned for this account yet.
          </p>
        )}

        <form action={logout}>
          <button
            type="submit"
            className="flex h-11 w-full items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            Log out
          </button>
        </form>
      </div>
    </main>
  )
}
