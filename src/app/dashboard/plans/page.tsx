import Link from 'next/link'

import { getCompany, getSubmissionCount } from '@/lib/dal'
import { isCompanyProfileComplete } from '@/lib/validation'

import { PlanGenerator } from './plan-generator'

/**
 * Below this many submissions the plan is generated anyway, but the owner is
 * told it may be thin.
 *
 * A threshold, not a gate. `context/changes/generate-action-plan/change.md`
 * carries the open question "minimalna liczba zgłoszeń dla sensownego planu"
 * with the owner and marks it non-blocking, and the PRD's only hard rule is
 * about ZERO submissions. Refusing at four would answer an open question by
 * fiat and would block the very first thing a new owner wants to try; saying
 * "this may be thin" tells them the truth and lets them judge.
 */
const THIN_PLAN_THRESHOLD = 5

/**
 * The action-plan surface (US-01, FR-011). Lives under /dashboard so the
 * existing PROTECTED_PREFIXES guard in src/proxy.ts covers it with no config
 * change; verifySession() inside the DAL is the actual boundary.
 *
 * The gating decision is made HERE, on the server, from a count read under RLS
 * — not in the client component from a prop it could be rendered without.
 * generatePlan() re-checks the same condition for itself, because a Server
 * Action is reachable without ever loading this page.
 */
export default async function PlansPage() {
  // Independent reads, so they overlap rather than queue. verifySession is
  // cache()d, so the two getUser() calls dedupe to one round trip.
  const [company, submissionCount] = await Promise.all([
    getCompany(),
    getSubmissionCount(),
  ])

  const profileComplete = isCompanyProfileComplete(company)

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
            Action plan
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Turn everything your customers have told you into a ranked set of
            problems and concrete steps.
          </p>
        </div>

        {!company ? (
          // The same branch every sibling page renders. RLS returns nothing for
          // a NULL current_company_id(), so without asking, this page could not
          // tell "no submissions yet" from "no tenant at all" — and would show
          // an encouraging empty state over a generate button that always
          // fails.
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No company is provisioned for this account yet.
          </p>
        ) : submissionCount === 0 ? (
          // PRD acceptance for US-01: with no submissions the action must be
          // "niedostępna lub pokazuje stan pusty z wyjaśnieniem, a nie
          // pusty/błędny plan". No button at all, and a route out of the dead
          // end rather than a bare refusal.
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-zinc-300 p-8 dark:border-zinc-700">
            <p className="text-sm font-medium text-black dark:text-zinc-50">
              There is nothing to analyse yet.
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              An action plan is built from what your customers actually said, so
              it needs submissions to work from. Collect a few — through your
              form link, or by adding them yourself — and the button will appear
              here.
            </p>
            <Link
              href="/dashboard/submissions"
              className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Add your first submission
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {submissionCount === 1
                ? 'The plan will be generated from your 1 submission.'
                : `The plan will be generated from your ${submissionCount} submissions.`}
            </p>

            {submissionCount < THIN_PLAN_THRESHOLD && (
              // Honest rather than blocking: the product's own claim is that it
              // finds problems that RECUR, and three submissions cannot show
              // recurrence. Saying so beats letting the owner conclude the
              // feature is weak.
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                With this few submissions the plan may be thin — there is not
                much for it to find a pattern in yet. It will still work, and it
                gets sharper as more come in.
              </p>
            )}

            {!profileComplete && (
              // The same amber prompt the dashboard uses, and for the same
              // reason it does not block there: industry and location change
              // which improvements are even plausible, but a plan without them
              // is still a plan.
              <div className="flex flex-col items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  Your company profile is incomplete.
                </p>
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  Filling it in tells the plan what kind of business it is
                  advising, so the steps fit your business rather than any
                  business.
                </p>
                <Link
                  href="/dashboard/company"
                  className="text-sm font-medium text-amber-900 underline underline-offset-4 dark:text-amber-200"
                >
                  Complete your profile
                </Link>
              </div>
            )}

            <PlanGenerator />
          </div>
        )}
      </div>
    </main>
  )
}
