'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { accountDeletionPhrase } from '@/lib/account-deletion'
import { verifySession } from '@/lib/dal'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import {
  CompanyProfileSchema,
  type CompanyProfileField,
  type FormState,
} from '@/lib/validation'

/**
 * Persists the owner's company profile (FR-002).
 *
 * A Server Action is a POST to the route it lives on, so the proxy matcher
 * does not guard it — `verifySession()` here, not the proxy, is the auth
 * boundary for this path.
 */
export async function updateCompanyProfile(
  _prevState: FormState<CompanyProfileField>,
  formData: FormData
): Promise<FormState<CompanyProfileField>> {
  const user = await verifySession()

  const validatedFields = CompanyProfileSchema.safeParse({
    name: formData.get('name'),
    industry: formData.get('industry'),
    description: formData.get('description'),
    location: formData.get('location'),
  })

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
    }
  }

  const supabase = await createClient()

  // The owner filter is deliberate, and deliberately unlike getCompany(),
  // which relies on RLS alone. The failure modes are not symmetric: an
  // over-matching SELECT leaks, but an over-matching UPDATE rewrites every
  // visible row. RLS is still the security boundary; this is the seatbelt.
  // Do not "simplify" it away for consistency with the read path.
  // .select('id') is not decoration: an UPDATE matching zero rows comes back
  // as { data: null, error: null }, so without it a write that touched nothing
  // is indistinguishable from a successful one and the owner is told their
  // profile was saved. Asking for the affected row is what makes the no-op
  // visible. (Same silent-denial shape the isolation suite pins.)
  const { data, error } = await supabase
    .from('companies')
    .update(validatedFields.data)
    .eq('owner_id', user.id)
    .select('id')

  if (error) {
    console.error('company profile update failed:', error.code, error.message)
    return {
      message: 'Could not save your company profile. Please try again.',
    }
  }

  if (!data?.length) {
    console.error('company profile update matched no row for owner', user.id)
    return {
      message: 'Could not save your company profile. Please try again.',
    }
  }

  revalidatePath('/dashboard/company')
  revalidatePath('/dashboard')

  return {
    message: 'Company profile saved.',
  }
}

/**
 * Permanently erases the owner's account (FR-003, RODO erasure).
 *
 * Deleting the auth.users row is what does the work: companies.owner_id is
 * ON DELETE CASCADE, so the tenant row goes with it. Deleting only the company
 * row would instead orphan the tenant — current_company_id() would return NULL
 * for a still-signed-in owner, and the provisioning trigger only fires on user
 * insert, so it would never come back.
 *
 * SECURITY — this is the one place in the slice where a service-role client
 * (which bypasses RLS entirely) serves a user request. The id passed to
 * deleteUser comes from verifySession() and from nothing else. It must never
 * be read from FormData, a query param, or a hidden input: an id taken from
 * the request would let any authenticated owner delete any account.
 */
export async function deleteAccount(
  _prevState: FormState<'confirmation'>,
  formData: FormData
): Promise<FormState<'confirmation'>> {
  const user = await verifySession()

  const supabase = await createClient()

  // Re-read the owner's own company (RLS-scoped) so the expected phrase is
  // derived server-side. The client's copy is a UI affordance, not authority.
  const { data: company, error: readError } = await supabase
    .from('companies')
    .select('name')
    .maybeSingle()

  // Fail closed rather than falling through. If this read errors, company is
  // undefined and the expected phrase would silently degrade to the generic
  // fallback while the form still shows the real company name — the owner's
  // correct input would be rejected, and the gate would stop being specific to
  // their company. A transient failure must not reshape the confirmation.
  if (readError) {
    console.error(
      'account deletion pre-check failed:',
      readError.code,
      readError.message
    )
    return {
      message: 'Could not verify your account. Please try again.',
    }
  }

  const expected = accountDeletionPhrase(company?.name)
  const typed = String(formData.get('confirmation') ?? '').trim()

  if (typed !== expected) {
    return {
      errors: {
        confirmation: [`Type ${expected} exactly to confirm.`],
      },
    }
  }

  const admin = createAdminClient()
  const { error } = await admin.auth.admin.deleteUser(user.id)

  if (error) {
    console.error('account deletion failed:', error.status, error.message)
    return {
      message: 'Could not delete your account. Please try again.',
    }
  }

  // Past this point the account is gone and the outcome is final.
  //
  // scope: 'local' clears the cookie without calling the logout endpoint —
  // that endpoint would be asked to revoke a session for a user who no longer
  // exists, which can error. Any failure here is logged and ignored on
  // purpose: reporting "deletion failed" for an account that is already
  // deleted would strand the owner holding a cookie for nothing.
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })
  if (signOutError) {
    console.error(
      'sign-out after account deletion failed (non-fatal):',
      signOutError.message
    )
  }

  // Outside any try/catch on purpose: redirect() signals by throwing
  // NEXT_REDIRECT, so a catch block would swallow it.
  redirect('/login')
}
