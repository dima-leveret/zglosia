import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/database.types'

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
 *
 * This filter-free convention applies to READS only. Write paths add an
 * explicit owner filter as well: an over-matching select leaks, but an
 * over-matching update rewrites every visible row.
 */
export const getCompany = cache(async () => {
  await verifySession()

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, industry, description, location, created_at, updated_at')
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
})

/**
 * How many submissions one page render will show. The list is capped rather
 * than paginated: the owner's next action is "generate a plan from all of
 * these", not "page through them", so offset links would be scaffolding for a
 * workflow the product does not have.
 */
export const SUBMISSION_LIST_LIMIT = 100

/**
 * One row as the list renders it. Derived from the generated schema rather than
 * hand-written, so dropping a column from the select below is a type error in
 * the component instead of an undefined at runtime.
 */
export type SubmissionListRow = Pick<
  Database['public']['Tables']['submissions']['Row'],
  'id' | 'content' | 'source' | 'created_at'
>

/**
 * The newest submissions for the caller's company, plus the exact total.
 *
 * Same filter-free read convention as getCompany: RLS scopes the query to
 * company_id = current_company_id(), so no explicit company filter appears
 * here. The isolation is in Postgres.
 *
 * The count rides along on the same request (`count: 'exact'` on a limited
 * select returns the *unlimited* total) so the page can say "showing the latest
 * 100 of N" without a second round trip.
 */
export const getSubmissions = cache(async () => {
  await verifySession()

  const supabase = await createClient()
  const { data, count, error } = await supabase
    .from('submissions')
    .select('id, content, source, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    // Tiebreaker, not decoration: rows inserted in the same statement share
    // created_at, and this pair matches submissions_company_created_idx exactly
    // so the read stays an index scan.
    .order('id', { ascending: false })
    .limit(SUBMISSION_LIST_LIMIT)

  if (error) {
    throw error
  }

  // Deliberately uncast. supabase-js already infers the exact row shape from
  // the Database generic, so an `as SubmissionListRow[]` here would buy nothing
  // and would silence the very check the type exists for: with a cast, dropping
  // a column from the select above still compiles, and `source` arrives
  // undefined so every row renders the wrong provenance badge.
  return {
    submissions: data ?? [],
    total: count ?? 0,
  }
})

/**
 * Just the total, for the dashboard. `head: true` sends no rows back — the
 * dashboard needs the number, not the content.
 */
export const getSubmissionCount = cache(async () => {
  await verifySession()

  const supabase = await createClient()
  const { count, error } = await supabase
    .from('submissions')
    .select('id', { count: 'exact', head: true })

  if (error) {
    throw error
  }

  return count ?? 0
})
