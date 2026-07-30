import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Routes an unauthenticated visitor may not see. Optimistic pre-filter only —
// the real security boundary is RLS + the DAL, since Server Functions run as
// POSTs to their own route and can bypass a proxy matcher exclusion.
const PROTECTED_PREFIXES = ['/dashboard']

export async function proxy(request: NextRequest) {
  // Response the Supabase client writes refreshed session cookies onto. It must
  // be the object we return, or the refreshed cookie is dropped and the user is
  // intermittently logged out.
  let supabaseResponse = NextResponse.next({ request })

  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    request.nextUrl.pathname.startsWith(prefix)
  )

  let user = null

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            supabaseResponse = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    // Load-bearing: no logic between client creation and getUser(). getUser()
    // revalidates the session against Supabase (never trust getSession() here).
    const {
      data: { user: sessionUser },
    } = await supabase.auth.getUser()
    user = sessionUser
  } catch (error) {
    // Supabase unreachable, or env misconfigured (the `!` assertions above).
    // The proxy matcher covers nearly every route, so throwing here would 500
    // the whole site — including /login, the page a user needs to recover.
    // Fail open on public routes; protected ones fall through to the redirect
    // below with `user` still null, and the DAL re-checks on every read anyway.
    console.error('proxy: session refresh failed:', error)
    if (!isProtected) return supabaseResponse
  }

  if (!user && isProtected) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    const redirectResponse = NextResponse.redirect(url)
    // Carry any refreshed cookies onto the redirect so the session state stays
    // consistent across the hop.
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie)
    })
    return redirectResponse
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico
     * - common image assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
