import Link from 'next/link'

import {
  ACTION_PLAN_LIST_LIMIT,
  SUBMISSION_LIST_LIMIT,
  getActionPlans,
  getCompany,
  getSubmissionCount,
} from '@/lib/dal'
import { isCompanyProfileComplete } from '@/lib/validation'

import { PLAN_LIST_EMPTY } from './messages'
import { PlanGenerator } from './plan-generator'
import { PlanList, type PlanListItem } from './plan-list'

/**
 * Fixed locale, formatted on the server, same as every other date in the app —
 * the ambient locale would render one string on the server and another after
 * hydration.
 */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

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
 * The action-plan surface (US-01, FR-011) and, since S-04, the saved-plans
 * index (FR-013). Lives under /dashboard so the
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
  // cache()d, so the three getUser() calls dedupe to one round trip.
  const [company, submissionCount, plans] = await Promise.all([
    getCompany(),
    getSubmissionCount(),
    getActionPlans(),
  ])

  const profileComplete = isCompanyProfileComplete(company)

  // Formatted here, on the server, for the reason the submissions page states:
  // the list below is a client component, so formatting there would run in the
  // browser's zone on hydration and the server's zone on render — two different
  // days for the same plan near midnight.
  const items: PlanListItem[] = plans.map((plan) => ({
    id: plan.id,
    problemCount: plan.problemCount,
    edited: plan.edited,
    isoDate: plan.created_at,
    formattedDate: dateFormatter.format(new Date(plan.created_at)),
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
            {/* Never a number the model will not actually see. getSubmissions()
                caps the read at SUBMISSION_LIST_LIMIT — a deliberate prompt-token
                budget, not an oversight — so past that the plan is built from the
                newest 100 and a bare total would promise coverage the prompt does
                not have. Same rule the submissions list states at
                dashboard/submissions/page.tsx:82. */}
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {submissionCount === 1
                ? 'The plan will be generated from your 1 submission.'
                : submissionCount > SUBMISSION_LIST_LIMIT
                  ? `The plan will be generated from your most recent ${SUBMISSION_LIST_LIMIT} of ${submissionCount} submissions.`
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

        {/* Everything saved (FR-013), replacing S-03's single "latest plan"
            link — which existed only because there was no list yet.

            Rendered OUTSIDE the submission-count branches on purpose: a saved
            plan outlives the submissions it was generated from (FR-009 lets the
            owner delete them), so an owner at zero submissions can still have
            plans here, and that is exactly when the dead end above would be
            most confusing. */}
        {company && (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {plans.length === 0
                  ? 'Saved plans'
                  : plans.length === 1
                    ? '1 saved plan'
                    : `${plans.length} saved plans`}
              </h2>
              {/* Explicit rather than silently truncating: the owner should
                  never be told a number the list below does not contain. The
                  same rule the submissions list states. */}
              {plans.length === ACTION_PLAN_LIST_LIMIT && (
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                  Showing the latest {ACTION_PLAN_LIST_LIMIT}
                </p>
              )}
            </div>

            {plans.length > 0 ? (
              <PlanList plans={items} />
            ) : (
              <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {PLAN_LIST_EMPTY}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
