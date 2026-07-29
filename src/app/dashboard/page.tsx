import Link from 'next/link'

import { getCompany } from '@/lib/dal'
import { isCompanyProfileComplete } from '@/lib/validation'

import { logout } from './actions'

/**
 * The isolation proof surface: reads the caller's own company through the DAL
 * (RLS-scoped), so rendering it proves the session and per-owner isolation both
 * work end-to-end. Unauthenticated access is already redirected by the proxy
 * and by verifySession() inside the DAL.
 */
export default async function DashboardPage() {
  const company = await getCompany()
  // Every account starts with a blank auto-provisioned row, so this is the
  // default state for a new owner — not an edge case.
  const profileComplete = isCompanyProfileComplete(company)

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Dashboard
        </h1>

        {company ? (
          <>
            {profileComplete ? (
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex flex-col">
                  <dt className="text-zinc-500 dark:text-zinc-500">
                    Company name
                  </dt>
                  <dd className="text-black dark:text-zinc-50">
                    {company.name}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-zinc-500 dark:text-zinc-500">Industry</dt>
                  <dd className="text-black dark:text-zinc-50">
                    {company.industry}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-zinc-500 dark:text-zinc-500">Location</dt>
                  <dd className="text-black dark:text-zinc-50">
                    {company.location}
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  Your company profile is incomplete.
                </p>
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  Fill it in so the action plans generated from your submissions
                  reflect your business.
                </p>
              </div>
            )}

            <Link
              href="/dashboard/company"
              className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              {profileComplete ? 'Edit company profile' : 'Complete your profile'}
            </Link>
          </>
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
