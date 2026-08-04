'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getCompany, verifySession } from '@/lib/dal'
import { createClient } from '@/lib/supabase/server'
import {
  SubmissionSchema,
  type FormState,
  type SubmissionField,
} from '@/lib/validation'

import {
  SUBMISSION_ADDED,
  SUBMISSION_DELETED,
  SUBMISSION_DELETE_FAILED,
  SUBMISSION_SAVE_FAILED,
} from './messages'

/**
 * Records one manually entered submission (FR-008).
 *
 * A Server Action is a POST to the route it lives on, so the proxy matcher
 * does not guard it — `verifySession()` here, not the proxy, is the auth
 * boundary for this path.
 */
export async function createSubmission(
  _prevState: FormState<SubmissionField>,
  formData: FormData
): Promise<FormState<SubmissionField>> {
  await verifySession()

  // Kept raw and untrimmed: this is what gets echoed back to the textarea if
  // anything below rejects, and the owner should get their own keystrokes
  // returned rather than a normalized version of them.
  const submitted = formData.get('content')
  const echo = typeof submitted === 'string' ? submitted : ''

  const validatedFields = SubmissionSchema.safeParse({ content: submitted })

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
      values: { content: echo },
    }
  }

  // SECURITY — company_id comes from the session-scoped read and from nothing
  // else. Never FormData, never a query param, never a hidden input. The RLS
  // `with check` would reject a forged id anyway, but the application must not
  // be the layer that tries. Same invariant deleteAccount documents.
  const company = await getCompany()

  // getCompany() is typed nullable and both existing pages render a "no company
  // provisioned" branch for it. Return the generic failure rather than
  // dereferencing null, which would throw into dashboard/error.tsx for a state
  // the rest of the app handles gracefully.
  if (!company) {
    console.error('createSubmission: no company provisioned for this owner')
    return { message: SUBMISSION_SAVE_FAILED, values: { content: echo } }
  }

  const supabase = await createClient()

  // source is pinned here AND in the RLS `with check`. The policy is what makes
  // it a guarantee; this is just the honest caller.
  // .select('id') is not decoration: a write matching zero rows comes back as
  // { data: null, error: null }, so without it a no-op insert is
  // indistinguishable from a successful one and the owner is told it saved.
  const { data, error } = await supabase
    .from('submissions')
    .insert({
      company_id: company.id,
      content: validatedFields.data.content,
      source: 'manual',
    })
    .select('id')

  if (error) {
    console.error('submission insert failed:', error.code, error.message)
    return { message: SUBMISSION_SAVE_FAILED, values: { content: echo } }
  }

  if (!data?.length) {
    console.error('submission insert matched no row for company', company.id)
    return { message: SUBMISSION_SAVE_FAILED, values: { content: echo } }
  }

  revalidatePath('/dashboard/submissions')
  revalidatePath('/dashboard')

  // No `values` on purpose: their absence is what lets the form clear.
  return { message: SUBMISSION_ADDED }
}

/**
 * Validates the id before it reaches PostgREST. Without this a malformed id
 * comes back as a 22P02 cast error rather than a clean rejection, which is a
 * database error surfacing as if it were a user-facing failure.
 */
const DeleteSubmissionSchema = z.object({
  id: z.uuid(),
})

/**
 * Permanently removes one submission belonging to the caller's company
 * (FR-009). Hard delete: no soft-delete column, no undo, no trash.
 */
// FormState<never>, not FormState<'submission'>: this action returns only a
// `message` and has no per-field error channel at all. Naming a field the
// action can never populate is the exact drift the generic parameter exists to
// prevent (see the FormState doc comment in validation.ts).
export async function deleteSubmission(
  _prevState: FormState<never>,
  formData: FormData
): Promise<FormState<never>> {
  await verifySession()

  const validatedFields = DeleteSubmissionSchema.safeParse({
    id: formData.get('id'),
  })

  if (!validatedFields.success) {
    console.error('deleteSubmission: malformed submission id')
    return { message: SUBMISSION_DELETE_FAILED }
  }

  // SECURITY — same invariant as createSubmission: the company scope comes from
  // the session, never from the request. Only the id is caller-supplied, and it
  // is constrained by the company filter below plus RLS.
  const company = await getCompany()

  if (!company) {
    console.error('deleteSubmission: no company provisioned for this owner')
    return { message: SUBMISSION_DELETE_FAILED }
  }

  const supabase = await createClient()

  // The company_id filter is the same seatbelt the update path documents. RLS
  // is the boundary, but the failure modes are not symmetric: an over-matching
  // SELECT leaks, while an over-matching DELETE destroys rows outright.
  // .select('id') is what makes a zero-row delete visible — without it, deleting
  // someone else's id or a row that no longer exists comes back indistinguishable
  // from success and the owner is told it worked.
  const { data, error } = await supabase
    .from('submissions')
    .delete()
    .eq('id', validatedFields.data.id)
    .eq('company_id', company.id)
    .select('id')

  if (error) {
    console.error('submission delete failed:', error.code, error.message)
    return { message: SUBMISSION_DELETE_FAILED }
  }

  if (!data?.length) {
    console.error(
      'submission delete matched no row for company',
      company.id
    )
    // Revalidate before returning, unlike the error branch above. Zero rows
    // usually means the submission is already gone — deleted in another tab, or
    // on a page left open since. Returning without revalidating leaves the
    // stale row rendered under a failure message, and every retry reproduces
    // the same failure forever. Re-rendering the list is what makes that
    // recoverable.
    revalidatePath('/dashboard/submissions')
    revalidatePath('/dashboard')

    return { message: SUBMISSION_DELETE_FAILED }
  }

  revalidatePath('/dashboard/submissions')
  revalidatePath('/dashboard')

  return { message: SUBMISSION_DELETED }
}
