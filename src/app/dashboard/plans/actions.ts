'use server'

import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { NoObjectGeneratedError, Output, generateText } from 'ai'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { getCompany, getSubmissions, verifySession } from '@/lib/dal'
import { buildPlanPrompt } from '@/lib/plan-prompt'
import {
  PlanOutputSchema,
  VerifiedPlanSchema,
  resolveCitations,
  type VerifiedPlan,
} from '@/lib/plan-schema'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/lib/validation'

import {
  PLAN_DELETED,
  PLAN_DELETE_FAILED,
  PLAN_GENERATION_FAILED,
  PLAN_GENERATION_THROTTLED,
  PLAN_GENERATION_TIMED_OUT,
  PLAN_NO_SUBMISSIONS,
  PLAN_SAVE_FAILED,
} from './messages'

/**
 * How long the model gets before the request is abandoned.
 *
 * 120s, raised from the 60s the plan specified: a plan over a realistic set of
 * submissions is several thousand output tokens of reasoning, and a model that
 * is merely slow was being cut off and reported as a failure the owner could do
 * nothing about. The retry it prompted cost another ledger slot for the same
 * work.
 *
 * It still sits well inside Vercel's 300s function default, which is the
 * constraint that actually bounds this number: the timeout has to fire here so
 * it surfaces as this app's own message rather than as a platform error page.
 * `context/foundation/infrastructure.md` names that platform error as its
 * top-likelihood risk for this slice. Raise this past ~240s and that ordering
 * inverts.
 *
 * PROGRESS_STAGE_MS in plan-generator.tsx is paced against this budget — move
 * one and the stage list either runs out early or never reaches its last entry.
 */
const PLAN_GENERATION_TIMEOUT_MS = 120_000

/**
 * What the generate button gets back. Exactly one of `plan` or `message` is
 * populated: a plan means "review this", a message means "here is why there is
 * nothing to review".
 */
export type GenerateState =
  | {
      /** The verified artifact, every citation resolved to a real submission. */
      plan?: VerifiedPlan
      /**
       * The cited submissions' text, keyed by id — only the ones the plan
       * actually cites.
       *
       * It rides along because the review screen shows every citation verbatim,
       * and the generation action is the one place that already holds both the
       * plan and the submissions behind it. Without this the review component
       * would have to re-read the submissions to display words it was just
       * handed, and the owner would be shown a problem with no customer voice
       * under it — the "another statistics tool" outcome the roadmap rules out.
       */
      citedSubmissions?: Record<string, string>
      message?: string
    }
  | undefined

/**
 * Whether a thrown error is an abort rather than a failure.
 *
 * `AbortSignal.timeout()` rejects with a DOMException named 'TimeoutError';
 * a caller-cancelled request surfaces as 'AbortError', and Next.js uses
 * 'ResponseAborted' when the client disconnects. Matching on `name` is the same
 * shape @ai-sdk/provider-utils uses internally — reimplemented in three lines
 * rather than imported, because that package is a transitive dependency this
 * app does not declare.
 */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      error.name === 'ResponseAborted')
  )
}

/**
 * Generates an action plan from the caller's own submissions (US-01, FR-011).
 *
 * Returns the plan for review; it writes NOTHING to the plan tables. Saving is
 * a separate, deliberate act — which is exactly why the spend cap below binds
 * the generation rather than the save: capping saves would leave
 * generate-and-discard unbounded, and that is the loop a stuck retry falls
 * into.
 *
 * A Server Action is a POST to the route it lives on, so src/proxy.ts's matcher
 * does not guard it — `verifySession()` here, not the proxy, is the auth
 * boundary for this path, exactly as every sibling action documents.
 *
 * It takes NO parameters, and that is the security statement of this signature.
 * `useActionState` calls it with (prevState, formData); this action reads
 * neither, because there is nothing about a generation the caller gets to
 * choose. The company comes from the session, the submissions come from the
 * DAL under RLS, and the model and its budget are configuration. A request that
 * carries no input cannot carry a forged one.
 */
export async function generatePlan(): Promise<GenerateState> {
  await verifySession()

  // SECURITY — the company scope comes from the session-scoped read and from
  // nothing else. Never FormData, never a query param. The same invariant
  // save_action_plan() re-establishes for itself in Postgres by calling
  // current_company_id() instead of accepting a company argument.
  const company = await getCompany()

  if (!company) {
    console.error('generatePlan: no company provisioned for this owner')
    return { message: PLAN_GENERATION_FAILED }
  }

  // RLS scopes this to the caller's company, so the numbered list the model
  // sees can only ever contain this owner's own submissions. That is the first
  // reason a cited index cannot name another tenant's row.
  const { submissions } = await getSubmissions()

  // Before the ledger and before the model: an owner with nothing to analyse
  // must not spend a generation slot, and must not be charged for a call whose
  // input is empty. The page already hides the button in this state; this is
  // the server-side half of the same decision.
  if (submissions.length === 0) {
    return { message: PLAN_NO_SUBMISSIONS }
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  const modelId = process.env.ZGLOSIA_PLAN_MODEL

  // Checked here rather than at module scope so a missing key is one failed
  // action with a logged cause, not a route that throws on import and takes the
  // whole dashboard down.
  if (!apiKey || !modelId) {
    console.error(
      'generatePlan: OPENROUTER_API_KEY or ZGLOSIA_PLAN_MODEL is not set'
    )
    return { message: PLAN_GENERATION_FAILED }
  }

  const supabase = await createClient()

  // ORDERING IS LOAD-BEARING — the ledger row is written BEFORE the model call,
  // and it is kept whether that call goes on to succeed, fail or time out.
  // Recording only successes would mean a caller looping on a request that dies
  // mid-flight is never counted and the cap never binds, which is the runaway
  // this row exists to prevent.
  //
  // .select('id') is the same seatbelt createSubmission documents: without it a
  // write matching zero rows returns { data: null, error: null } and an
  // uncounted attempt looks identical to a counted one.
  const { data: ledgerRow, error: ledgerError } = await supabase
    .from('plan_generations')
    .insert({ company_id: company.id })
    .select('id')

  if (ledgerError) {
    console.error(
      'plan generation ledger insert failed:',
      ledgerError.code,
      ledgerError.message
    )

    // PT429 is raised by enforce_plan_generation_rate(); PostgREST maps a PTxyz
    // sqlstate onto HTTP status xyz and supabase-js surfaces it on error.code.
    // Branching on the code, never on the message text.
    if (ledgerError.code === 'PT429') {
      return { message: PLAN_GENERATION_THROTTLED }
    }

    return { message: PLAN_GENERATION_FAILED }
  }

  if (!ledgerRow?.length) {
    console.error(
      'plan generation ledger insert matched no row for company',
      company.id
    )
    return { message: PLAN_GENERATION_FAILED }
  }

  const { system, prompt } = buildPlanPrompt({ company, submissions })

  const openrouter = createOpenRouter({ apiKey })

  let output

  try {
    const result = await generateText({
      // structuredOutputs.strict = false: the provider defaults json_schema to
      // strict mode, and strict mode rejects several of the keywords Zod emits
      // for the bounds in plan-schema.ts (maxLength, maxItems) on some upstream
      // providers — a hard 400 rather than a weaker plan. The bounds are not
      // lost by relaxing this: the SDK validates the parsed response against the
      // same Zod schema and throws NoObjectGeneratedError on any violation.
      model: openrouter.chat(modelId, {
        structuredOutputs: { strict: false },
      }),
      // AI SDK: the structured result is `result.output`, NOT `result.object`.
      // Reading `.object` yields undefined and every field then validates as
      // missing — a silent failure that looks like a bad model rather than a
      // wrong property name.
      output: Output.object({ schema: PlanOutputSchema }),
      system,
      prompt,
      abortSignal: AbortSignal.timeout(PLAN_GENERATION_TIMEOUT_MS),
      // The plan is explicit that this slice does no automatic retry and no
      // backoff — the owner presses the button again. The SDK would otherwise
      // retry twice inside the same 60s budget, spending most of it on a
      // provider that is already failing, against a ledger slot that is
      // already gone.
      maxRetries: 0,
    })

    // Read inside the try on purpose: `.output` is a getter that throws
    // NoOutputGeneratedError when the model stopped for any reason other than
    // 'stop' — hitting the token limit, most commonly.
    output = result.output
  } catch (error) {
    if (isAbortError(error)) {
      console.error(
        'plan generation aborted after',
        PLAN_GENERATION_TIMEOUT_MS,
        'ms for company',
        company.id
      )
      return { message: PLAN_GENERATION_TIMED_OUT }
    }

    if (NoObjectGeneratedError.isInstance(error)) {
      // Kept separate from transport failure in the LOG, not in the message:
      // "the model ignored the schema" and "OpenRouter is down" need different
      // fixes from us and the same next step from the owner.
      console.error('plan generation returned no valid object:', error.message)
      return { message: PLAN_GENERATION_FAILED }
    }

    console.error('plan generation failed:', error)
    return { message: PLAN_GENERATION_FAILED }
  }

  // The numbering contract: the SAME array in the SAME order that
  // buildPlanPrompt() numbered from 1 is what the indexes resolve against.
  const { plan, droppedIndexes, droppedProblems } = resolveCitations(
    output,
    submissions.map((submission) => submission.id)
  )

  // Logged, never silent. A model that has started inventing citations shows up
  // here first, and a drop that nobody records is a drift nobody notices.
  if (droppedIndexes.length > 0) {
    console.warn(
      'plan generation dropped out-of-range citation(s)',
      droppedIndexes,
      'for company',
      company.id
    )
  }

  if (droppedProblems.length > 0) {
    console.warn(
      'plan generation dropped ungrounded problem(s)',
      droppedProblems,
      'for company',
      company.id
    )
  }

  // Total collapse. A plan with zero problems is not a plan — showing an empty
  // one would be the "pusty/błędny plan" the PRD's US-01 acceptance criteria
  // rule out, so this fails outright instead.
  if (!plan) {
    console.error(
      'plan generation produced no grounded problem for company',
      company.id
    )
    return { message: PLAN_GENERATION_FAILED }
  }

  // Only what the plan cites. The review screen needs the customer's words next
  // to each problem; it does not need the other 90 submissions, and putting
  // them through the wire twice for nothing is how a 100-row list becomes a
  // slow round trip.
  const cited = new Set(plan.problems.flatMap((problem) => problem.submissionIds))
  const citedSubmissions = Object.fromEntries(
    submissions
      .filter((submission) => cited.has(submission.id))
      .map((submission) => [submission.id, submission.content])
  )

  // Nothing has been written to the plan tables. Saving is savePlan()'s job,
  // and the owner may well discard this instead.
  return { plan, citedSubmissions }
}

/**
 * What the save button gets back. Only a failure ever reaches the component: a
 * successful save redirects, and `redirect()` throws a control-flow exception,
 * so there is no success message to render on this side.
 */
export type SaveState = { message?: string } | undefined

/**
 * Persists a reviewed plan on the caller's company account (FR-012).
 *
 * The plan arrives as JSON in the POST body — it has already been over the wire
 * once — and this action re-derives every guarantee rather than trusting it.
 * The company is read from the session inside Postgres by
 * `save_action_plan()` (`current_company_id()`, never an argument), and every
 * citation is re-checked there against that company's own submissions inside
 * the transaction. So the round trip through the browser is NOT a trust
 * boundary: a tampered payload can misspell a title, but it cannot attach a
 * plan to another company, and it cannot cite a submission the owner does not
 * have — that save aborts whole rather than saving a thinner plan.
 *
 * Zod's job here is narrower than it looks: reject a malformed body cleanly, so
 * a broken payload is one logged failure rather than a 22P02 cast error
 * surfacing out of PostgREST as if it were a user-facing problem.
 */
export async function savePlan(
  _prevState: SaveState,
  formData: FormData
): Promise<SaveState> {
  await verifySession()

  const posted = formData.get('plan')

  if (typeof posted !== 'string') {
    console.error('savePlan: no plan in the request body')
    return { message: PLAN_SAVE_FAILED }
  }

  let parsedJson: unknown

  // JSON.parse throws on malformed input, and an uncaught throw in a Server
  // Action becomes the dashboard error boundary — a whole-page failure for
  // what is one bad request.
  try {
    parsedJson = JSON.parse(posted)
  } catch {
    console.error('savePlan: plan payload is not valid JSON')
    return { message: PLAN_SAVE_FAILED }
  }

  const validatedPlan = VerifiedPlanSchema.safeParse(parsedJson)

  if (!validatedPlan.success) {
    console.error(
      'savePlan: plan payload failed validation:',
      validatedPlan.error.message
    )
    return { message: PLAN_SAVE_FAILED }
  }

  const supabase = await createClient()

  // One RPC, one transaction. supabase-js has no transaction API, and this
  // write spans four tables — a sequence of separate inserts would leave a plan
  // header with no problems under it whenever one of them failed midway.
  const { data: planId, error } = await supabase.rpc('save_action_plan', {
    p_summary: validatedPlan.data.summary,
    p_problems: validatedPlan.data.problems,
  })

  if (error) {
    // Logged, never surfaced. The RPC's own message names how many citations
    // failed to resolve and for which company — precisely what a tampered
    // client would want to learn about which of its forged ids was rejected.
    console.error('save_action_plan failed:', error.code, error.message)
    return { message: PLAN_SAVE_FAILED }
  }

  if (!planId) {
    console.error('save_action_plan returned no plan id')
    return { message: PLAN_SAVE_FAILED }
  }

  // The dashboard renders counts that this write changes, and /dashboard/plans
  // now renders a link to the newest saved plan — which this write is. Both
  // paths are listed explicitly because revalidatePath does not cascade to
  // nested routes; without the second one the client router can serve a cached
  // payload pointing at the previous plan.
  //
  // Revalidate BEFORE redirecting: redirect() throws, so nothing after it runs.
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/plans')

  redirect(`/dashboard/plans/${planId}`)
}

/**
 * Where a successful delete may send the caller.
 *
 * A literal, not a path shape. The plan's own page has to leave after deleting
 * the thing it renders, while a list row must stay put — so the caller does
 * need to say which. But "the caller chooses a destination" is an open redirect
 * the moment the destination is anything it can spell, and a hidden field is
 * trivially rewritten. Matching one literal keeps the choice binary: this page,
 * or stay.
 */
const DELETE_PLAN_REDIRECT = '/dashboard/plans'

/**
 * Validates the id before it reaches PostgREST, exactly as deleteSubmission
 * does: without this a malformed id comes back as a 22P02 cast error rather
 * than a clean rejection.
 */
const DeletePlanSchema = z.object({
  id: z.uuid(),
})

/**
 * Permanently removes one saved plan belonging to the caller's company
 * (FR-014). Hard delete, and the only write in this feature that does NOT go
 * through a security-definer RPC.
 *
 * That exception is deliberate and is stated in the migration: every structural
 * write needs an invariant re-derived inside Postgres — a partial one corrupts
 * the plan — but a whole-plan delete has no invariant to protect. The children
 * go with it on the FK cascade, so `delete` on action_plans is granted directly
 * and scoped by the action_plans_delete_own policy. No child table has a delete
 * grant.
 */
// FormState<never>, like deleteSubmission: this action returns only a
// `message` and has no per-field error channel at all.
export async function deletePlan(
  _prevState: FormState<never>,
  formData: FormData
): Promise<FormState<never>> {
  await verifySession()

  const validatedFields = DeletePlanSchema.safeParse({
    id: formData.get('id'),
  })

  if (!validatedFields.success) {
    console.error('deletePlan: malformed plan id')
    return { message: PLAN_DELETE_FAILED }
  }

  const posted = formData.get('redirectTo')
  const redirectTo = posted === DELETE_PLAN_REDIRECT ? posted : null

  // SECURITY — the company scope comes from the session-scoped read and from
  // nothing else. Only the id is caller-supplied, and it is constrained by the
  // company filter below plus RLS.
  const company = await getCompany()

  if (!company) {
    console.error('deletePlan: no company provisioned for this owner')
    return { message: PLAN_DELETE_FAILED }
  }

  const supabase = await createClient()

  // The company_id filter is the same seatbelt deleteSubmission documents. RLS
  // is the boundary, but the failure modes are not symmetric: an over-matching
  // SELECT leaks, while an over-matching DELETE destroys rows outright.
  // .select('id') is what makes a zero-row delete visible — without it,
  // deleting another owner's plan id comes back indistinguishable from success
  // and the owner is told it worked.
  const { data, error } = await supabase
    .from('action_plans')
    .delete()
    .eq('id', validatedFields.data.id)
    .eq('company_id', company.id)
    .select('id')

  if (error) {
    console.error('plan delete failed:', error.code, error.message)
    return { message: PLAN_DELETE_FAILED }
  }

  if (!data?.length) {
    console.error('plan delete matched no row for company', company.id)

    // Revalidate before returning, unlike the error branch above. Zero rows
    // usually means the plan is already gone — deleted in another tab, or on a
    // page left open since. Returning without revalidating leaves the stale row
    // rendered under a permanent failure, and every retry reproduces it. Same
    // reasoning deleteSubmission records.
    revalidatePath('/dashboard/plans')

    return { message: PLAN_DELETE_FAILED }
  }

  // Both paths, because revalidatePath does not cascade to nested routes: the
  // index loses a row, and the deleted plan's own route must stop serving a
  // cached payload for a plan that no longer exists.
  revalidatePath('/dashboard/plans')
  revalidatePath(`/dashboard/plans/${validatedFields.data.id}`)

  if (redirectTo) {
    // Only reachable from the plan's own page, which cannot stay on a route
    // that now 404s. redirect() throws, so nothing below it runs — which is why
    // the revalidations are above.
    redirect(redirectTo)
  }

  return { message: PLAN_DELETED }
}
