import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'

/**
 * `next` is attacker-controlled, and `new URL(next, base)` drops the base for
 * absolute (`https://evil.com`), protocol-relative (`//evil.com`) and backslash
 * (`/\evil.com`) values. A crafted link would hand a freshly minted session to
 * another origin, so only same-origin paths get through.
 */
function safeNextPath(value: string | null) {
  if (!value?.startsWith('/')) return '/dashboard'
  if (value.startsWith('//') || value.startsWith('/\\')) return '/dashboard'
  return value
}

/**
 * Completes the magic link server-side. Supabase's email template points here
 * with `?token_hash=…&type=email`; we exchange the token for a session (the
 * server client writes the session cookie via the cookie adapter), then send
 * the owner on to the dashboard. Any failure falls back to /login with a flag.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = safeNextPath(searchParams.get('next'))

  if (token_hash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })

    if (!error) {
      // Assigning `.pathname` keeps the request's own origin — the host can no
      // longer be influenced by the query string.
      const redirectTo = request.nextUrl.clone()
      redirectTo.pathname = next
      redirectTo.search = ''
      return NextResponse.redirect(redirectTo)
    }

    console.error('verifyOtp failed:', error.status, error.code, error.message)
  } else {
    console.error('confirm route missing params:', { token_hash: !!token_hash, type })
  }

  return NextResponse.redirect(new URL('/login?error=invalid_link', request.url))
}
