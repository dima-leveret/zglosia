'use server'

import { z } from 'zod'

import { createPublicClient } from '@/lib/supabase/server'
import {
  SubmissionSchema,
  type FormState,
  type SubmissionField,
} from '@/lib/validation'

import {
  PUBLIC_SUBMISSION_BLANK,
  PUBLIC_SUBMISSION_FAILED,
  PUBLIC_SUBMISSION_SENT,
  PUBLIC_SUBMISSION_THROTTLED,
} from './messages'
import { HONEYPOT_FIELD, MIN_ELAPSED_MS, RENDERED_AT_FIELD } from './screening'

/**
 * Validates the id before it reaches PostgREST, exactly as deleteSubmission
 * does: without it a malformed segment comes back as a 22P02 cast error, which
 * is a database error surfacing as if it were a user-facing failure.
 */
const CompanyIdSchema = z.uuid()

/**
 * Records one customer submission against the company named in the URL
 * (US-02, FR-006).
 *
 * SECURITY — there is no `verifySession()` here, no `getCompany()`, and no
 * `createClient()`. That absence is the security property of this file, not an
 * oversight: every other action in the codebase opens by proving who the caller
 * is, and this one runs for a stranger with no account by design. The action is
 * an honest caller, not a boundary. Every rule that matters is in Postgres and
 * would hold against a direct PostgREST call with the public anon key:
 *
 *   - `source` must be 'form'    — submissions_insert_public_form's with check
 *   - the company must exist     — the FK on company_id (23503)
 *   - content bounded, non-blank — submissions_content_bounds (23514)
 *   - 30 per company per hour    — enforce_form_submission_rate (PT429)
 *
 * `companyId` leads the parameter list because the caller supplies it with
 * `.bind()`, so it comes from the route segment rather than from an editable
 * hidden input in the customer's own DOM.
 */
export async function submitPublicSubmission(
  companyId: string,
  _prevState: FormState<SubmissionField>,
  formData: FormData
): Promise<FormState<SubmissionField>> {
  // Kept raw and untrimmed: this is what gets echoed back to the textarea if
  // anything below rejects, and the customer should get their own keystrokes
  // returned rather than a normalized version of them. Losing what somebody
  // typed to a validation error is the guardrail this slice exists to protect.
  const submitted = formData.get('content')
  const echo = typeof submitted === 'string' ? submitted : ''

  // --- Screening. Both branches return the SUCCESS message without writing:
  // a bot must not learn it was detected, or the next attempt simply omits
  // whatever gave it away. Logged server-side so the signal is not lost.
  const honeypot = formData.get(HONEYPOT_FIELD)

  if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
    console.warn('public submission screened: honeypot filled', companyId)
    return { message: PUBLIC_SUBMISSION_SENT }
  }

  const renderedAt = Number(formData.get(RENDERED_AT_FIELD))

  // A missing or unparseable timestamp is NOT treated as a bot. Omitting the
  // field is exactly as cheap as forging it — the value is unsigned either way —
  // so rejecting on absence buys nothing against a real bot while costing a real
  // customer whose page came from a stale cache their whole submission. The
  // database cap is the layer that bounds abuse; this one is a speed bump.
  if (Number.isFinite(renderedAt) && Date.now() - renderedAt < MIN_ELAPSED_MS) {
    console.warn('public submission screened: submitted too fast', companyId)
    return { message: PUBLIC_SUBMISSION_SENT }
  }

  // --- Validation.
  if (!CompanyIdSchema.safeParse(companyId).success) {
    console.error('submitPublicSubmission: malformed company id')
    return { message: PUBLIC_SUBMISSION_FAILED, values: { content: echo } }
  }

  const validatedFields = SubmissionSchema.safeParse({ content: submitted })

  if (!validatedFields.success) {
    // SubmissionSchema is shared with the owner's add form and its messages are
    // English. This surface substitutes its own Polish string rather than
    // echoing a validation message the customer would not understand — the only
    // field error this form can produce is "you typed nothing".
    return {
      errors: { content: [PUBLIC_SUBMISSION_BLANK] },
      values: { content: echo },
    }
  }

  // Session-less on purpose — see createPublicClient(). With the cookie-bound
  // client, an owner filling in their own form while logged in would execute as
  // `authenticated` and be rejected for source = 'form'.
  const supabase = createPublicClient()

  // No .select(), unlike both sibling actions in dashboard/submissions: `anon`
  // has no select grant and INSERT ... RETURNING requires one. That is fine
  // here, because the failure modes are not symmetric. The .select('id')
  // seatbelt exists to catch a SILENT zero-row UPDATE/DELETE; a rejected INSERT
  // is loud on its own (42501 from the policy, 23503 from the FK, 23514 from the
  // CHECK, PT429 from the trigger) and arrives on `error`.
  //
  // source is pinned here AND in the RLS `with check`. The policy is what makes
  // it a guarantee; this is just the honest caller.
  const { error } = await supabase.from('submissions').insert({
    company_id: companyId,
    content: validatedFields.data.content,
    source: 'form',
  })

  if (error) {
    console.error('public submission insert failed:', error.code, error.message)

    // PT429 is raised by enforce_form_submission_rate(); PostgREST maps a PTxyz
    // sqlstate onto HTTP status xyz and supabase-js surfaces it on error.code.
    // Branching on the code, never on the message text.
    if (error.code === 'PT429') {
      return { message: PUBLIC_SUBMISSION_THROTTLED, values: { content: echo } }
    }

    // Everything else — 23503 for a link whose company is gone, 42501, anything
    // unforeseen — is one generic failure. The customer cannot act on the
    // difference, and the database's own message is never surfaced.
    return { message: PUBLIC_SUBMISSION_FAILED, values: { content: echo } }
  }

  // No revalidatePath. The owner's list is a per-session dynamic render behind
  // verifySession(), so there is no shared cache entry for an anonymous request
  // to invalidate — and an anonymous caller must not be able to reach into the
  // owner's rendering anyway.
  //
  // No `values` on purpose: their absence is what lets the form clear.
  return { message: PUBLIC_SUBMISSION_SENT }
}
