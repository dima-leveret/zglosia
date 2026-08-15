'use client'

import Link from 'next/link'
import { useCallback, useRef, useState } from 'react'

import type { ActionPlanListRow } from '@/lib/dal'

import { PLAN_DELETED } from './messages'
import { PlanRow } from './plan-row'

/**
 * One saved plan with its dates already formatted. Formatting happens on the
 * server (see page.tsx) and arrives here as a string on purpose: this component
 * renders on both server and client, and `Intl.DateTimeFormat` without an
 * explicit timeZone resolves against the ambient zone — which differs between
 * the two and would produce a hydration mismatch, or worse, two different days
 * for the same plan.
 */
export type PlanListItem = Pick<
  ActionPlanListRow,
  'id' | 'problemCount' | 'edited'
> & {
  /** ISO 8601, for the <time> element's machine-readable value. */
  isoDate: string
  /** Server-formatted, for display. */
  formattedDate: string
}

/**
 * List of saved plans, newest first (FR-013).
 *
 * A client component, unlike the page above it, for the reason SubmissionList
 * records: the live region and focus anchor used after a delete must OUTLIVE
 * the row that was deleted. A confirmed delete revalidates, the row unmounts,
 * and anything the row owned — its focus target, its announcement — goes with
 * it, leaving focus on <body> at the top of the page. Both therefore live here.
 */
export function PlanList({ plans }: { plans: PlanListItem[] }) {
  const [status, setStatus] = useState('')
  const statusRef = useRef<HTMLParagraphElement>(null)

  // Stable identity: the row depends on this in an effect, and a fresh function
  // each render would let that effect re-fire and steal focus back.
  const handleDeleted = useCallback(() => {
    setStatus(PLAN_DELETED)
    // Focus a stable element outside the removed row. Focusing the live region
    // itself does double duty: it rescues focus AND gets the message read, so
    // the outcome is announced even where a polite region would be missed.
    statusRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-3">
      {/* Always present, empty until something happens — a live region has to
          exist in the DOM before its content changes to be announced reliably. */}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="text-sm text-zinc-600 outline-none empty:hidden dark:text-zinc-400"
      >
        {status}
      </p>

      <ul className="flex flex-col gap-3">
        {plans.map((plan) => (
          <PlanRow key={plan.id} id={plan.id} onDeleted={handleDeleted}>
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/dashboard/plans/${plan.id}`}
                  className="text-sm font-medium text-black underline-offset-4 hover:underline dark:text-zinc-50"
                >
                  Plan from{' '}
                  <time dateTime={plan.isoDate}>{plan.formattedDate}</time>
                </Link>

                {/* The visible half of the snapshot. `edited` is
                    original_content !== null — the same flag the database uses
                    as its write-once guard — so this badge and the "view the
                    original" affordance on the plan's own page can never
                    disagree. */}
                {plan.edited && (
                  <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                    Edited
                  </span>
                )}
              </div>

              <p className="text-xs text-zinc-500 dark:text-zinc-500">
                {plan.problemCount === 1
                  ? '1 problem'
                  : `${plan.problemCount} problems`}
              </p>
            </div>
          </PlanRow>
        ))}
      </ul>
    </div>
  )
}
