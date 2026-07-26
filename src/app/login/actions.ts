'use server'

import { headers } from 'next/headers'

import { createClient } from '@/lib/supabase/server'
import { LoginSchema, type FormState } from '@/lib/validation'

/**
 * Validates the submitted email and asks Supabase to send a magic link pointed
 * at our server-side confirm route. Returns a state object for `useActionState`
 * (field errors on invalid input, a confirmation or provider-error message
 * otherwise). Never reveals whether the email maps to an existing account.
 */
export async function sendMagicLink(
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const validatedFields = LoginSchema.safeParse({
    email: formData.get('email'),
  })

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
    }
  }

  const { email } = validatedFields.data

  const origin = (await headers()).get('origin') ?? ''
  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/confirm`,
    },
  })

  if (error) {
    console.error('signInWithOtp failed:', error.status, error.code, error.message)
    if (error.status === 429) {
      return {
        message: 'Too many sign-in emails right now. Please wait a bit and try again.',
      }
    }
    return {
      message: 'Could not send the magic link. Please try again.',
    }
  }

  return {
    message: `Check your inbox — we sent a sign-in link to ${email}.`,
  }
}
