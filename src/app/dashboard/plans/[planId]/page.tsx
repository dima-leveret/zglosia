import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'

import { getActionPlan } from '@/lib/dal'

/**
 * A saved action plan, read-only (FR-012 — "wygenerowany plan można zapisać i
 * odnaleźć później na koncie").
 *
 * This is the second half of savePlan()'s redirect: the plan is not really
 * saved, in the sense the acceptance criterion means, until there is a URL that
 * still shows it after a reload and a re-login.
 *
 * NO ORACLE. An id that names no plan and an id that names ANOTHER owner's plan
 * both reach notFound() and render the same 404 — never a message separating
 * the two. That distinction is exactly the membership oracle
 * src/app/dashboard/submissions/messages.ts:18 refuses to build: with it, a
 * stranger holding a plan id learns whether it exists, which is one bit more
 * than "firma nigdy nie widzi planów innej firmy" allows. The isolation itself
 * is in Postgres — RLS returns zero rows — and this page only has to avoid
 * telling on it.
 *
 * Read-only by design: no edit, no delete, no list. FR-013 and FR-014 are S-04.
 */

/**
 * The segment is matched by the router, not validated by it. Without this a
 * malformed id reaches PostgREST as a 22P02 cast error and surfaces as the
 * dashboard error boundary — a whole-page failure for what is, semantically, a
 * 404: an id that cannot be a uuid names no plan.
 */
const PlanIdSchema = z.uuid()

/**
 * Fixed locale, formatted on the server, same as the submissions list — the
 * ambient locale would render one date for the server and another after
 * hydration.
 */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export default async function SavedPlanPage({
  params,
}: {
  params: Promise<{ planId: string }>
}) {
  const { planId } = await params

  if (!PlanIdSchema.safeParse(planId).success) {
    notFound()
  }

  const plan = await getActionPlan(planId)

  if (!plan) {
    notFound()
  }

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
            Saved action plan
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Generated on {dateFormatter.format(new Date(plan.created_at))}.
          </p>
        </div>

        <div className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Summary
            </h2>
            {/* The generated content is Polish; the chrome around it is
                English. lang="pl" tells a screen reader to switch voices rather
                than read Polish with English pronunciation rules — the same
                split the review screen makes. */}
            <p
              lang="pl"
              className="text-sm whitespace-pre-line text-black dark:text-zinc-50"
            >
              {plan.summary}
            </p>
          </div>

          <ol className="flex flex-col gap-4">
            {plan.problems.map((problem) => (
              <li
                key={problem.id}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="flex items-baseline gap-2">
                  {/* The stored `rank`, not the array position: rank is what
                      save_action_plan() persisted as the priority order, and
                      showing the position instead would silently re-number the
                      plan if a row ever went missing. */}
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    #{problem.rank}
                  </span>
                  <h3
                    lang="pl"
                    className="text-sm font-semibold text-black dark:text-zinc-50"
                  >
                    {problem.title}
                  </h3>
                </div>

                <p
                  lang="pl"
                  className="text-sm text-zinc-700 dark:text-zinc-300"
                >
                  {problem.rationale}
                </p>

                <div className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    {problem.citations.length === 1
                      ? 'Based on 1 submission'
                      : `Based on ${problem.citations.length} submissions`}
                  </h4>
                  {problem.citations.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {problem.citations.map((citation) => (
                        <li
                          key={citation.id}
                          className="border-l-2 border-zinc-300 pl-3 text-sm text-zinc-600 italic dark:border-zinc-700 dark:text-zinc-400"
                        >
                          {/* lang is unset on purpose: this is the customer's
                              own text, and the app does not know what language
                              they wrote in. */}
                          {citation.content}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    // Not an error state. Citations cascade away when the owner
                    // deletes a submission (FR-009), so a saved problem can end
                    // up with none — the plan records what was true when it was
                    // generated, and saying so beats rendering a heading over
                    // nothing.
                    <p className="text-sm text-zinc-500 dark:text-zinc-500">
                      The submissions behind this problem have since been
                      deleted.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                    What to do
                  </h4>
                  <ol
                    lang="pl"
                    className="flex list-decimal flex-col gap-1 pl-5 text-sm text-black dark:text-zinc-50"
                  >
                    {problem.actions.map((action) => (
                      <li key={action.id}>{action.content}</li>
                    ))}
                  </ol>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <Link
          href="/dashboard/plans"
          className="text-sm text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          Generate another plan
        </Link>
      </div>
    </main>
  )
}
