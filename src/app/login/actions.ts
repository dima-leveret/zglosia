'use server'

import { createClient } from '@/lib/supabase/server'
import { LoginSchema, type FormState } from '@/lib/validation'

/**
 * The magic link's destination must never be derived from the request. Next's
 * Server Action CSRF check only requires `Origin` to *match* `Host` — it pins
 * neither to our real domain — so a spoofed pair would put an attacker's host
 * into a genuine Supabase email and hand them the one-time token. Pin it to a
 * server-side value instead, and keep this origin in Supabase's redirect
 * allow-list (see supabase/config.toml [auth]).
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is the platform-injected production domain
 * (host only, no scheme) — still a server-side value, never request-derived. It
 * backstops a forgotten `NEXT_PUBLIC_SITE_URL` on Vercel so a deploy cannot
 * silently mail out `http://localhost:3000` links; localhost stays the default
 * only when neither is set (local dev).
 */
function resolveSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  return 'http://localhost:3000'
}

const SITE_URL = resolveSiteUrl()

/**
 * Validates the submitted email and asks Supabase to send a magic link pointed
 * at our server-side confirm route. Returns a state object for `useActionState`
 * (field errors on invalid input, a confirmation or provider-error message
 * otherwise). Never reveals whether the email maps to an existing account.
 */
export async function sendMagicLink(
  _prevState: FormState<'email'>,
  formData: FormData
): Promise<FormState<'email'>> {
  const validatedFields = LoginSchema.safeParse({
    email: formData.get('email'),
  })

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors,
    }
  }

  const { email } = validatedFields.data

  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${SITE_URL}/auth/confirm`,
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
