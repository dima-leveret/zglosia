import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'

import { getActionPlan } from '@/lib/dal'
import { PlanOriginalSchema, type PlanOriginal } from '@/lib/plan-schema'

import { PlanDetail } from './plan-detail'

/**
 * One saved action plan, and everything the owner can do to it (FR-012,
 * FR-013, FR-014).
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
 * Since S-04 the page is still the fetch + 404 boundary and nothing else: the
 * read/edit/original toggle and the delete arm live in <PlanDetail>, a client
 * component, because that is state rather than data.
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

  // PARSED, not cast. The column is jsonb behind a shallow
  // `jsonb_typeof(...) = 'object'` CHECK, so the generated types can say no
  // more than "some json" — and a render of `.problems.map` over an object that
  // does not have it would throw the whole page. Its only writer is
  // update_action_plan(), which builds it from rows that already passed the
  // table CHECKs, so a parse failure here is a defect rather than an attack;
  // null then means the same thing to the view as "never edited", except the
  // view says so instead of crashing.
  let original: PlanOriginal | null = null

  if (plan.original_content !== null) {
    const parsed = PlanOriginalSchema.safeParse(plan.original_content)

    if (parsed.success) {
      original = parsed.data
    } else {
      console.error(
        'saved plan: original_content failed validation for plan',
        plan.id,
        parsed.error.message
      )
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <Link
          href="/dashboard/plans"
          className="text-sm text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          ← All saved plans
        </Link>

        <PlanDetail
          plan={{ id: plan.id, summary: plan.summary, problems: plan.problems }}
          createdAt={dateFormatter.format(new Date(plan.created_at))}
          updatedAt={dateFormatter.format(new Date(plan.updated_at))}
          // Two props rather than one, because a snapshot that failed to parse
          // must still read as edited: the flag is the column being non-null,
          // the content is what survived parsing.
          edited={plan.original_content !== null}
          original={original}
        />
      </div>
    </main>
  )
}
