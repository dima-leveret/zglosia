import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/database.types'
// The two read caps live in a pure module rather than here: this one carries
// `server-only`, and plan-schema.ts — which the client-side plan editor imports
// its bounds from — needs SUBMISSION_LIST_LIMIT. See list-limits.ts.
import {
  ACTION_PLAN_LIST_LIMIT,
  SUBMISSION_LIST_LIMIT,
} from '@/lib/list-limits'

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
 * One saved plan as its page renders it (S-03, FR-012).
 *
 * Every field type is derived from the generated schema rather than
 * hand-written, for the reason SubmissionListRow documents: dropping a column
 * from the select below then becomes a type error in the page instead of an
 * undefined at runtime.
 */
export type ActionPlanCitation = Pick<
  Database['public']['Tables']['submissions']['Row'],
  'id' | 'content'
>

export type ActionPlanAction = Pick<
  Database['public']['Tables']['plan_actions']['Row'],
  'id' | 'content'
>

export type ActionPlanProblem = Pick<
  Database['public']['Tables']['plan_problems']['Row'],
  'id' | 'rank' | 'title' | 'rationale'
> & {
  actions: ActionPlanAction[]
  /**
   * The submissions this problem was drawn from — the anti-hallucination NFR
   * made visible. Can legitimately be empty: citations cascade away when the
   * owner deletes a cited submission (FR-009), and the plan records what was
   * true when it was generated.
   */
  citations: ActionPlanCitation[]
}

/**
 * `original_content` arrives as raw jsonb — `Json | null` — and is deliberately
 * NOT parsed here. It is a snapshot `update_action_plan()` builds inside
 * Postgres, so it is trusted enough to store but not to render: the component
 * that displays it runs it through a Zod schema first, the same way every other
 * jsonb round trip in this feature is validated at its edge. Null means "never
 * edited" — it is both the flag and the store, which is why there is no
 * separate edited_at column.
 */
export type ActionPlanDetail = Pick<
  Database['public']['Tables']['action_plans']['Row'],
  'id' | 'summary' | 'created_at' | 'updated_at' | 'original_content'
> & { problems: ActionPlanProblem[] }

/**
 * One saved plan with its problems, their steps and the submissions behind
 * them. Returns null when the id names no plan the caller may read.
 *
 * Same filter-free read convention as getCompany and getSubmissions: there is
 * no company filter here, because RLS scopes all four tables to
 * current_company_id() — action_plans on the column directly, the other three
 * through an EXISTS up the parent chain. `.eq('id', ...)` is a row selector,
 * not a tenant filter: another owner's plan id matches the predicate and is
 * still returned as zero rows, which is why the caller cannot tell "does not
 * exist" from "not yours" and must not try.
 *
 * ONE round trip, not four. The embedded select walks
 * action_plans → plan_problems → {plan_actions, plan_problem_submissions →
 * submissions}, so a plan with eight problems is still a single request rather
 * than an N+1 across the chain.
 *
 * Ordering is applied here in JS rather than as PostgREST `order` parameters.
 * `rank` and `position` are unique per parent and both collections are tiny
 * (at most 8 problems, 5 actions), so the sort costs nothing — and one
 * mechanism that works identically at every nesting depth beats two that
 * differ at the second level.
 */
export const getActionPlan = cache(
  async (planId: string): Promise<ActionPlanDetail | null> => {
    await verifySession()

    const supabase = await createClient()
    const { data, error } = await supabase
      .from('action_plans')
      .select(
        `id, summary, created_at, updated_at, original_content,
         plan_problems (
           id, rank, title, rationale,
           plan_actions ( id, position, content ),
           plan_problem_submissions ( submissions ( id, content ) )
         )`
      )
      .eq('id', planId)
      .maybeSingle()

    if (error) {
      throw error
    }

    if (!data) {
      return null
    }

    return {
      id: data.id,
      summary: data.summary,
      created_at: data.created_at,
      updated_at: data.updated_at,
      original_content: data.original_content,
      problems: [...data.plan_problems]
        .sort((a, b) => a.rank - b.rank)
        .map((problem) => ({
          id: problem.id,
          rank: problem.rank,
          title: problem.title,
          rationale: problem.rationale,
          actions: [...problem.plan_actions]
            .sort((a, b) => a.position - b.position)
            .map((action) => ({ id: action.id, content: action.content })),
          citations: problem.plan_problem_submissions
            .map((citation) => citation.submissions)
            // A citation row cannot outlive its submission — the FK cascades —
            // so this filter is about the join's TYPE, which is nullable
            // because PostgREST cannot know the FK is NOT NULL, not about a
            // row shape that occurs in practice.
            .filter((submission) => submission !== null)
            .map((submission) => ({
              id: submission.id,
              content: submission.content,
            })),
        })),
    }
  }
)

/**
 * One saved plan as the index renders it.
 *
 * `problemCount` and `edited` are computed in the mapping below rather than in
 * the component, so no surface re-derives them — and in particular so "edited"
 * has ONE definition (`original_content is not null`, which is the same flag
 * the database uses as its write-once guard) instead of one per renderer.
 */
export type ActionPlanListRow = Pick<
  Database['public']['Tables']['action_plans']['Row'],
  'id' | 'created_at' | 'updated_at'
> & {
  problemCount: number
  edited: boolean
}

/**
 * Every saved plan for the caller's company, newest first (FR-013).
 *
 * Same filter-free read convention as every other read in this module: RLS
 * scopes action_plans to company_id = current_company_id(), so no company
 * filter appears here. The isolation is in Postgres.
 *
 * ONE round trip. `plan_problems(count)` is a PostgREST aggregate on the
 * embedded relation, so the per-plan problem count comes back with the header
 * row instead of as a second query per plan. The count is subject to the same
 * RLS as a direct read of plan_problems, which is what makes it safe to show.
 */
export const getActionPlans = cache(
  async (): Promise<ActionPlanListRow[]> => {
    await verifySession()

    const supabase = await createClient()
    const { data, error } = await supabase
      .from('action_plans')
      .select('id, created_at, updated_at, original_content, plan_problems(count)')
      .order('created_at', { ascending: false })
      // Tiebreaker, not decoration: plans saved in the same statement share
      // created_at, and this pair matches action_plans_company_created_idx
      // exactly so the read stays an index scan.
      .order('id', { ascending: false })
      .limit(ACTION_PLAN_LIST_LIMIT)

    if (error) {
      throw error
    }

    return (data ?? []).map((plan) => ({
      id: plan.id,
      created_at: plan.created_at,
      updated_at: plan.updated_at,
      // PostgREST returns an aggregate on an embedded relation as a one-element
      // array, and an empty one when the relation has no rows — which a plan
      // cannot legitimately be in (save_action_plan() writes at least one
      // problem and update_action_plan() refuses to remove the last), so the
      // fallback is defensive rather than expected.
      problemCount: plan.plan_problems[0]?.count ?? 0,
      edited: plan.original_content !== null,
    }))
  }
)

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
