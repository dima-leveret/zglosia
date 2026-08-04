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

const FAILURE_MESSAGE = 'Could not save the submission. Please try again.'

/**
 * Deliberately generic, and deliberately the same string whether the row does
 * not exist or belongs to another company. Telling the owner "that submission
 * isn't yours" would confirm that the id exists — a membership oracle over
 * other tenants' primary keys.
 */
const DELETE_FAILURE_MESSAGE =
  'Could not delete that submission. Please try again.'

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
    return { message: FAILURE_MESSAGE, values: { content: echo } }
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
    return { message: FAILURE_MESSAGE, values: { content: echo } }
  }

  if (!data?.length) {
    console.error('submission insert matched no row for company', company.id)
    return { message: FAILURE_MESSAGE, values: { content: echo } }
  }

  revalidatePath('/dashboard/submissions')
  revalidatePath('/dashboard')

  // No `values` on purpose: their absence is what lets the form clear.
  return { message: 'Submission added.' }
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
export async function deleteSubmission(
  _prevState: FormState<'submission'>,
  formData: FormData
): Promise<FormState<'submission'>> {
  await verifySession()

  const validatedFields = DeleteSubmissionSchema.safeParse({
    id: formData.get('id'),
  })

  if (!validatedFields.success) {
    console.error('deleteSubmission: malformed submission id')
    return { message: DELETE_FAILURE_MESSAGE }
  }

  // SECURITY — same invariant as createSubmission: the company scope comes from
  // the session, never from the request. Only the id is caller-supplied, and it
  // is constrained by the company filter below plus RLS.
  const company = await getCompany()

  if (!company) {
    console.error('deleteSubmission: no company provisioned for this owner')
    return { message: DELETE_FAILURE_MESSAGE }
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
    return { message: DELETE_FAILURE_MESSAGE }
  }

  if (!data?.length) {
    console.error(
      'submission delete matched no row for company',
      company.id
    )
    return { message: DELETE_FAILURE_MESSAGE }
  }

  revalidatePath('/dashboard/submissions')
  revalidatePath('/dashboard')

  return { message: 'Submission deleted.' }
}
