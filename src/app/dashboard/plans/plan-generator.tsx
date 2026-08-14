'use client'

import { useActionState, useEffect, useState } from 'react'

import type { VerifiedPlan } from '@/lib/plan-schema'

import { generatePlan, savePlan } from './actions'
import { PLAN_DISCARDED } from './messages'

/**
 * The named stages the progress indicator walks through while the model is
 * working.
 *
 * They are honest about their own imprecision: the model call is one opaque
 * round trip, so these describe what is being ASKED for, not measured progress
 * through it. The NFR wants continuous visible feedback — "żadna operacja
 * trwająca dłużej niż ~2 s nie sprawia wrażenia zawieszonej" — and a single
 * "Loading…" over a call that can run for the better part of a minute is
 * exactly the hung-looking silence it rules out. What it does not want is a
 * fake percentage, so nothing here claims one.
 */
const PROGRESS_STAGES = [
  'Reading your submissions…',
  'Grouping them into recurring problems…',
  'Ranking the problems by weight and urgency…',
  'Drafting the steps for each problem…',
  'Checking every problem against your own submissions…',
] as const

/**
 * How long each stage is shown. Five stages at 8s covers 40s of the 60s budget
 * and the last one then holds — deliberately, because a stage list that runs
 * out and resets would tell the owner the work restarted.
 */
const PROGRESS_STAGE_MS = 8_000

/**
 * The generate → review → save/discard surface (US-01, FR-011, FR-012).
 *
 * Two Server Actions, two `useActionState` hooks, and one piece of local state
 * (`discarded`). Generation returns the plan as its VALUE rather than writing
 * it: nothing is persisted until the owner has read it and pressed Save, which
 * is what makes Discard a genuine no-op on the database.
 */
export function PlanGenerator() {
  const [state, generate, generating] = useActionState(generatePlan, undefined)
  const [discarded, setDiscarded] = useState(false)
  const [stage, setStage] = useState(0)

  // The stage timer runs only while the action is pending. It only ever sets
  // state from the interval callback — the reset that belongs to *starting* a
  // run happens in the submit handler below, where an event, not an effect, is
  // what React wants driving it.
  useEffect(() => {
    if (!generating) {
      return
    }

    const timer = setInterval(() => {
      setStage((current) => Math.min(current + 1, PROGRESS_STAGES.length - 1))
    }, PROGRESS_STAGE_MS)

    return () => clearInterval(timer)
  }, [generating])

  const plan = state?.plan

  if (plan && !discarded) {
    return (
      <PlanReview
        plan={plan}
        citedSubmissions={state?.citedSubmissions ?? {}}
        onDiscard={() => setDiscarded(true)}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        action={generate}
        // Both resets belong to the act of starting a run, not to a render
        // pass: the stage list must open at its first entry rather than
        // wherever the previous run left it, and a new generation supersedes
        // whatever was discarded before it. onSubmit fires before the action,
        // and does not preventDefault, so the action still runs.
        onSubmit={() => {
          setStage(0)
          setDiscarded(false)
        }}
      >
        <button
          type="submit"
          disabled={generating}
          className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
        >
          {generating ? 'Generating…' : 'Generate action plan'}
        </button>
      </form>

      {generating && <GenerationProgress stage={stage} />}

      {/* The outcome line: a failure, a throttle, an empty state — or the
          confirmation that a discard wrote nothing. Never a plan; that path
          returns above. */}
      {!generating && (discarded || state?.message) && (
        <p
          aria-live="polite"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          {discarded ? PLAN_DISCARDED : state?.message}
        </p>
      )}
    </div>
  )
}

/**
 * The staged progress indicator.
 *
 * `role="status"` rather than a bare paragraph so a screen-reader user gets the
 * stage changes announced too — the whole point of this element is that the
 * owner can tell the work is still moving, and that has to hold without sight
 * of the bar.
 *
 * The bar's width tracks the stage index, so it advances in five honest steps
 * rather than pretending to a smooth percentage; the pulse is what shows
 * liveness in between.
 */
function GenerationProgress({ stage }: { stage: number }) {
  const width = ((stage + 1) / PROGRESS_STAGES.length) * 100

  return (
    <div className="flex flex-col gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full animate-pulse rounded-full bg-foreground transition-[width] duration-700 ease-out"
          style={{ width: `${width}%` }}
        />
      </div>
      <p
        role="status"
        className="text-sm text-zinc-600 dark:text-zinc-400"
      >
        {PROGRESS_STAGES[stage]}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-500">
        This usually takes under a minute. Keep this page open.
      </p>
    </div>
  )
}

/**
 * The review screen: the generated plan, read-only, with Save and Discard.
 *
 * Every problem is rendered together with the customer submissions it was drawn
 * from, verbatim. That is not decoration — it is the anti-hallucination NFR
 * made visible to the person who can actually judge it. A problem shown without
 * the words behind it is the "kolejne narzędzie do statystyk" the roadmap says
 * this product must not be, and the owner is the only reader who can tell a
 * real recurring theme from a plausible-sounding invention.
 *
 * No editing here, by design: the plan is accepted or discarded whole. Editing
 * arrives in S-04, against saved rows rather than against this in-memory shape.
 */
function PlanReview({
  plan,
  citedSubmissions,
  onDiscard,
}: {
  plan: VerifiedPlan
  citedSubmissions: Record<string, string>
  onDiscard: () => void
}) {
  const [state, save, saving] = useActionState(savePlan, undefined)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Summary
        </h2>
        {/* The generated content is Polish; the chrome around it is English.
            lang="pl" tells a screen reader to switch voices rather than read
            Polish with English pronunciation rules. */}
        <p
          lang="pl"
          className="text-sm whitespace-pre-line text-black dark:text-zinc-50"
        >
          {plan.summary}
        </p>
      </div>

      <ol className="flex flex-col gap-4">
        {plan.problems.map((problem, index) => (
          <li
            key={`${index}-${problem.title}`}
            className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex items-baseline gap-2">
              {/* Array position IS the priority order — the same convention
                  save_action_plan() uses when it assigns `rank` from the
                  position rather than trusting a field. */}
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                #{index + 1}
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
                {problem.submissionIds.length === 1
                  ? 'Based on 1 submission'
                  : `Based on ${problem.submissionIds.length} submissions`}
              </h4>
              <ul className="flex flex-col gap-2">
                {problem.submissionIds.map((id) => (
                  <li
                    key={id}
                    className="border-l-2 border-zinc-300 pl-3 text-sm text-zinc-600 italic dark:border-zinc-700 dark:text-zinc-400"
                  >
                    {/* lang is unset here on purpose: this is the customer's
                        own text, and the app does not know what language they
                        wrote in. */}
                    {citedSubmissions[id] ?? 'This submission is no longer available.'}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500">
                What to do
              </h4>
              <ol
                lang="pl"
                className="flex list-decimal flex-col gap-1 pl-5 text-sm text-black dark:text-zinc-50"
              >
                {problem.actions.map((action, actionIndex) => (
                  <li key={`${actionIndex}-${action}`}>{action}</li>
                ))}
              </ol>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <form action={save}>
            {/* The plan goes back the way it came. It is not a trust boundary:
                savePlan() re-parses it, and save_action_plan() re-checks every
                citation against the caller's own submissions inside the
                transaction. */}
            <input type="hidden" name="plan" value={JSON.stringify(plan)} />
            <button
              type="submit"
              disabled={saving}
              className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
            >
              {saving ? 'Saving…' : 'Save this plan'}
            </button>
          </form>

          {/* Outside the form, and type="button": discard is a local state
              change and must never post anything. Nothing has been written yet,
              so there is nothing to undo. */}
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="flex h-11 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-white/[.06]"
          >
            Discard
          </button>
        </div>

        {/* Only ever a failure: a successful save redirects out of this
            component before it can render anything. */}
        {state?.message && (
          <p
            aria-live="polite"
            className="text-sm text-red-700 dark:text-red-400"
          >
            {state.message}
          </p>
        )}
      </div>
    </div>
  )
}
