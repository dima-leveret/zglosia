'use server'

import { revalidatePath } from 'next/cache'

import { verifySession } from '@/lib/dal'
import { createClient } from '@/lib/supabase/server'
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
  const { error } = await supabase
    .from('companies')
    .update(validatedFields.data)
    .eq('owner_id', user.id)

  if (error) {
    console.error('company profile update failed:', error.code, error.message)
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
