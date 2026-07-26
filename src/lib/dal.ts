import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * The single auth gate. Every owner-facing data request calls this first.
 * Uses getUser() (revalidated against Supabase), memoized per render pass so
 * repeated calls in one request don't re-hit the network. Redirects to /login
 * when there is no authenticated user — this, not the proxy, is the boundary.
 */
export const verifySession = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return user
})

/**
 * Reads the caller's own company row. RLS scopes the query to owner_id =
 * auth.uid(), so no explicit owner filter is needed here — the isolation is
 * enforced in Postgres. Returns null only if the row is somehow absent.
 */
export const getCompany = cache(async () => {
  await verifySession()

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, created_at')
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
})
