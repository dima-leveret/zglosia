// This module exports the service-role client, which bypasses RLS entirely.
// The build-time guard is what keeps it — and SUPABASE_SERVICE_ROLE_KEY — out
// of any client bundle, rather than relying on the incidental `next/headers`
// import to break such a build.
import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Generated from the linked project:
//   npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts
// Regenerate after every migration. Both clients are parameterized with it so
// `.from('companies').select('...')` is checked against the real schema instead
// of degrading to `any` — a typo'd column name is then a build error, not a
// runtime surprise on a page nobody reloaded yet.
import type { Database } from './database.types'

/**
 * User-session server client bound to the request cookies. Queries Postgres
 * AS THE LOGGED-IN USER, so RLS applies — this is the client every owner-facing
 * server component / action / route handler must use. Isolation depends on it.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component where cookies are read-only.
            // Safe to ignore when the proxy refreshes the session instead.
          }
        },
      },
    }
  )
}

/**
 * Session-less client for the public submission form (S-06), the product's only
 * unauthenticated path. Queries Postgres AS `anon`, always.
 *
 * The absence of a cookie adapter is the feature, not an omission. `createClient()`
 * above binds to the request cookies, so if the person filling in the public form
 * happens to be a logged-in owner in that browser, the insert would execute as
 * `authenticated`, hit `submissions_insert_own_manual` — whose `with check` pins
 * `source = 'manual'` — and be rejected with 42501. That failure mode is closed,
 * not open, and it only bites the person most likely to test the form and least
 * likely to suspect the client. Reading no cookies is what makes the role
 * independent of who is browsing.
 *
 * Privileges are exactly what 20260809151843_public_submission_form.sql grants
 * `anon`: insert (company_id, content, source) on submissions, execute on
 * public_form_company(). No select on anything.
 */
export function createPublicClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Same reasoning as the admin client below: there is no user session to
      // keep alive here, and auth-js would otherwise leave a refresh ticker
      // behind on every request that constructs one.
      auth: { autoRefreshToken: false, persistSession: false },
    }
  )
}

/**
 * Service-role admin client that BYPASSES RLS. Reserved for privileged /
 * test-only operations — never use for owner-facing reads.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      // A service-role client has no user session to keep alive, but auth-js
      // defaults both of these to true and starts a refresh ticker anyway in
      // non-browser environments — leaving a setInterval behind on every
      // request that constructs one. Off, as the test suites already do.
      auth: { autoRefreshToken: false, persistSession: false },
    }
  )
}
