import { randomUUID } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireLocalDb } from './support/require-local-db'

/**
 * Phase 2 gate for S-04: the executable half of
 * 20260815160000_saved_plans_management.sql.
 *
 * That migration opens the only two write surfaces FR-014 needs — a `delete`
 * grant on action_plans and update_action_plan() — and claims a long list of
 * guarantees in prose. Prose cannot demonstrate any of them:
 *
 *   1. TENANCY. update_action_plan() is `security definer` and therefore
 *      bypasses RLS on every table it touches. One predicate inside the body is
 *      the whole of the isolation, and a version of the function without it
 *      would pass every structural test in this file.
 *   2. THE FLOORS AND THE RENUMBER. An edit removes by omission, so "a plan
 *      keeps at least one problem", "a problem keeps at least one action" and
 *      "rank/position stay contiguous from 1" are properties of the function,
 *      not of the schema. The renumber in particular is one offset pass away
 *      from raising 23505 on the exact edit this slice exists for.
 *   3. THE SNAPSHOT IS WRITTEN ONCE. `original_content is null` is both the
 *      never-edited flag and the write guard. A second edit overwriting it
 *      would silently turn "what the model produced" into "what it looked like
 *      last time", which reads correct on any single edit.
 *   4. WRITES ARE STILL RPC-ONLY. S-04 adds a delete grant. Re-proving that
 *      `update` stayed absent on all four tables, and `delete` on the three
 *      child tables, is what keeps that one new privilege from having quietly
 *      brought friends.
 *
 * This suite is also the compensating control for Progress item 1.1, which was
 * NOT run: there is no container runtime on the implementing machine, so the
 * migration was never applied to an empty local database via `supabase db
 * reset`. Every denial below is the behavioural evidence that the revoke-then-
 * grant block took effect — read them as the reason 1.1's absence is
 * survivable, not as belt-and-braces.
 *
 * Style follows tests/plans.test.ts exactly: a positive control first (without
 * it every denial would also pass on a function nobody can call at all), then
 * each denial on its own specific SQLSTATE. An empty array is never accepted as
 * evidence of a denial — it is also what a GRANTED select with no matching
 * policy returns, and the two mean opposite things.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing Supabase env. tests/plan-editing.test.ts needs NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (loaded from .env.local).'
  )
}

requireLocalDb(url, 'tests/plan-editing.test.ts')

/** Service-role client: bypasses RLS. Test-only — never an owner-facing read. */
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Mirrors src/lib/plan-schema.ts and the RPC's own bounds. */
const PLAN_PROBLEMS_MAX = 8
const PROBLEM_ACTIONS_MAX = 5

/**
 * The three plan tables that must still refuse UPDATE and DELETE after S-04,
 * with a column that really exists on each to filter on.
 * plan_problem_submissions has no surrogate key, and naming a column that does
 * not exist fails with 42703 before Postgres consults the privilege — a green
 * test proving nothing.
 */
const CHILD_TABLE_FILTER_COLUMN: Record<string, string> = {
  plan_problems: 'id',
  plan_actions: 'id',
  plan_problem_submissions: 'problem_id',
}

type Owner = {
  userId: string
  companyId: string
  /** Anon-key client carrying this owner's session, so grants AND RLS apply. */
  db: SupabaseClient
}

/**
 * Provisions a confirmed auth user and returns a client authenticated as them.
 * The company row comes from the `on_auth_user_created` trigger and is read
 * back through the service-role client, so setup never depends on the policies
 * under test.
 */
async function createOwner(label: string): Promise<Owner> {
  const email = `plan-edit-${label}-${randomUUID()}@example.com`
  const password = randomUUID()

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) throw createError
  if (!created.user) throw new Error(`createUser returned no user for ${label}`)

  const db = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInError } = await db.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  const { data: company, error: companyError } = await admin
    .from('companies')
    .select('id')
    .eq('owner_id', created.user.id)
    .single()
  if (companyError) throw companyError

  return { userId: created.user.id, companyId: company.id, db }
}

/** Seeds submissions past RLS and returns their ids in the order given. */
async function seedSubmissions(companyId: string, contents: string[]): Promise<string[]> {
  const { data, error } = await admin
    .from('submissions')
    .insert(contents.map((content) => ({ company_id: companyId, content, source: 'manual' })))
    .select('id, content')
  if (error) throw error
  return contents.map((content) => data!.find((row) => row.content === content)!.id)
}

type StoredAction = { id: string; position: number; content: string }

type StoredProblem = {
  id: string
  rank: number
  title: string
  rationale: string
  actions: StoredAction[]
  /** Cited submission ids, sorted — the grounding, read back. */
  citations: string[]
}

type StoredPlan = {
  id: string
  summary: string
  created_at: string
  updated_at: string
  original_content: unknown
  problems: StoredProblem[]
}

/**
 * The whole plan, read past RLS in the order the schema defines it.
 *
 * Service-role on purpose: these reads have to report what IS, including rows a
 * broken policy would hide. Every isolation assertion in this file compares an
 * owner-facing result against one of these.
 */
async function readPlan(planId: string): Promise<StoredPlan | null> {
  const { data: header, error: headerError } = await admin
    .from('action_plans')
    .select('id, summary, created_at, updated_at, original_content')
    .eq('id', planId)
    .maybeSingle()
  if (headerError) throw headerError
  if (!header) return null

  const { data: problems, error: problemsError } = await admin
    .from('plan_problems')
    .select('id, rank, title, rationale')
    .eq('plan_id', planId)
    .order('rank')
  if (problemsError) throw problemsError

  const problemIds = problems!.map((row) => row.id)
  if (problemIds.length === 0) {
    return { ...(header as Omit<StoredPlan, 'problems'>), problems: [] }
  }

  const [{ data: actions, error: actionsError }, { data: citations, error: citationsError }] =
    await Promise.all([
      admin
        .from('plan_actions')
        .select('id, problem_id, position, content')
        .in('problem_id', problemIds)
        .order('position'),
      admin
        .from('plan_problem_submissions')
        .select('problem_id, submission_id')
        .in('problem_id', problemIds),
    ])
  if (actionsError) throw actionsError
  if (citationsError) throw citationsError

  return {
    ...(header as Omit<StoredPlan, 'problems'>),
    problems: problems!.map((problem) => ({
      id: problem.id,
      rank: problem.rank,
      title: problem.title,
      rationale: problem.rationale,
      actions: actions!
        .filter((row) => row.problem_id === problem.id)
        .map(({ id, position, content }) => ({ id, position, content })),
      citations: citations!
        .filter((row) => row.problem_id === problem.id)
        .map((row) => row.submission_id)
        .sort(),
    })),
  }
}

type PlanSpec = {
  summary: string
  problems: {
    title: string
    rationale: string
    submissionIds: string[]
    actions: string[]
  }[]
}

/** Saves a plan through the S-03 RPC and reads it back with its real ids. */
async function seedPlan(owner: Owner, spec: PlanSpec): Promise<StoredPlan> {
  const { data: planId, error } = await owner.db.rpc('save_action_plan', {
    p_summary: spec.summary,
    p_problems: spec.problems,
  })
  if (error) throw error

  const plan = await readPlan(planId as string)
  if (!plan) throw new Error('seedPlan: saved plan could not be read back')
  return plan
}

/**
 * The stored plan turned back into the edit payload, unchanged.
 *
 * This is the identity edit — the shape the editor posts when the owner opens a
 * plan and saves without touching anything. Every case below starts from it and
 * mutates exactly the one thing under test, so a failure names that one thing.
 */
function toPayload(plan: StoredPlan) {
  return plan.problems.map((problem) => ({
    id: problem.id,
    title: problem.title,
    rationale: problem.rationale,
    actions: problem.actions.map((action) => ({ id: action.id, content: action.content })),
  }))
}

let ownerA: Owner
let ownerB: Owner
/** Owner A's submissions — the raw material every plan below cites. */
let subA: string[]

/** A four-problem plan of owner A's, freshly saved. */
async function seedFourProblemPlan(): Promise<StoredPlan> {
  return seedPlan(ownerA, {
    summary: 'Cztery problemy, żeby renumerowanie miało co przestawiać.',
    problems: [1, 2, 3, 4].map((n) => ({
      title: `Problem ${n}`,
      rationale: `Uzasadnienie problemu ${n}.`,
      submissionIds: [subA[(n - 1) % subA.length]],
      actions: [`Krok 1 problemu ${n}.`, `Krok 2 problemu ${n}.`],
    })),
  })
}

beforeAll(async () => {
  ;[ownerA, ownerB] = await Promise.all([createOwner('a'), createOwner('b')])

  // Only owner A needs raw material: owner B exists to be refused, and every
  // plan in this file is owner A's. Grounding across the tenant boundary is
  // save_action_plan()'s contract and is asserted in tests/plans.test.ts.
  subA = await seedSubmissions(ownerA.companyId, [
    'Czekałem 20 minut na kawę.',
    'Kolejka do kasy była ogromna.',
    'Kawa była zimna.',
  ])
})

afterAll(async () => {
  // companies.owner_id is ON DELETE CASCADE and action_plans cascades from
  // companies, so deleting the users clears every fixture row this suite wrote
  // — a second consecutive run starts empty.
  await Promise.all(
    [ownerA, ownerB].filter(Boolean).map(async (owner) => {
      await owner.db.auth.signOut()
      await admin.auth.admin.deleteUser(owner.userId)
    })
  )
})

describe('update_action_plan round trip', () => {
  it('rewrites the summary, a problem title and an action, and stamps updated_at', async () => {
    // The positive control. Without it every denial in this file would also
    // pass on a function that is broken outright — a missing execute grant, a
    // wrong argument name — and the suite would report a perfectly locked-down
    // edit surface that nobody can actually edit a plan with.
    const plan = await seedPlan(ownerA, {
      summary: 'Podsumowanie od modelu.',
      problems: [
        {
          title: 'Długi czas oczekiwania',
          rationale: 'Dwa zgłoszenia mówią o kolejce.',
          submissionIds: [subA[0], subA[1]],
          actions: ['Otwórz drugą kasę.', 'Wprowadź zamówienia mobilne.'],
        },
        {
          title: 'Zimna kawa',
          rationale: 'Jedno zgłoszenie o temperaturze.',
          submissionIds: [subA[2]],
          actions: ['Skalibruj ekspres.'],
        },
      ],
    })

    const payload = toPayload(plan)
    payload[0].title = 'Czas obsługi w godzinach szczytu'
    payload[0].actions[1].content = 'Uruchom zamówienia w aplikacji.'

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: 'Podsumowanie poprawione przez właściciela.',
      p_problems: payload,
    })
    expect(error).toBeNull()

    const after = await readPlan(plan.id)
    expect(after!.summary).toBe('Podsumowanie poprawione przez właściciela.')
    expect(after!.problems[0].title).toBe('Czas obsługi w godzinach szczytu')
    expect(after!.problems[0].actions[1].content).toBe('Uruchom zamówienia w aplikacji.')
    // Untouched fields stay untouched: an edit rewrites what was posted, not
    // everything it read.
    expect(after!.problems[1].title).toBe('Zimna kawa')

    // Nothing was removed, so the numbering is exactly what generation gave it.
    expect(after!.problems.map((problem) => problem.rank)).toEqual([1, 2])
    expect(after!.problems[0].actions.map((action) => action.position)).toEqual([1, 2])

    // The touch trigger fired. `updated_at` equals `created_at` until a plan is
    // first edited, which is what lets the detail page show "Edited on ..."
    // without a second column to disagree with.
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(plan.updated_at).getTime()
    )
  })

  it('leaves the citations of an edited problem alone', async () => {
    // The NFR under an edit. plan_problem_submissions is written only by
    // save_action_plan(); rewriting the words around the evidence must not cost
    // the evidence, or the grounding quietly decays with every correction the
    // owner makes.
    const plan = await seedPlan(ownerA, {
      summary: 'Plan, którego cytaty muszą przeżyć edycję.',
      problems: [
        {
          title: 'Cytowany problem',
          rationale: 'Opiera się na dwóch zgłoszeniach.',
          submissionIds: [subA[0], subA[1]],
          actions: ['Krok pierwszy.'],
        },
      ],
    })

    const payload = toPayload(plan)
    payload[0].title = 'Zupełnie inny tytuł'
    payload[0].rationale = 'Zupełnie inne uzasadnienie.'
    payload[0].actions[0].content = 'Zupełnie inny krok.'

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: 'Zupełnie inne podsumowanie.',
      p_problems: payload,
    })
    expect(error).toBeNull()

    const after = await readPlan(plan.id)
    expect(after!.problems[0].citations).toEqual(plan.problems[0].citations)
    expect(after!.problems[0].citations).toHaveLength(2)
  })
})

/**
 * The tenancy boundary. update_action_plan() is `security definer`, so it runs
 * as its owner and bypasses RLS on all four plan tables — the company predicate
 * inside the function is the only thing scoping the call. These cases are what
 * prove that predicate is really there.
 */
describe('update_action_plan tenancy', () => {
  it("refuses owner B an edit of owner A's plan, and changes nothing", async () => {
    const plan = await seedPlan(ownerA, {
      summary: 'Plan firmy A. Firma B nie może go edytować.',
      problems: [
        {
          title: 'Problem firmy A',
          rationale: 'Wyłącznie firmy A.',
          submissionIds: [subA[0]],
          actions: ['Krok firmy A.', 'Drugi krok firmy A.'],
        },
        {
          title: 'Drugi problem firmy A',
          rationale: 'Też wyłącznie firmy A.',
          submissionIds: [subA[1]],
          actions: ['Kolejny krok firmy A.'],
        },
      ],
    })
    const before = await readPlan(plan.id)

    // The realistic attack shape: owner B holds A's REAL problem and action
    // ids (leaked, guessed, whatever) and posts a payload that rewrites every
    // string and removes a problem. Only the company predicate stands between
    // that payload and A's rows.
    const payload = toPayload(plan)
      .slice(0, 1)
      .map((problem) => ({
        ...problem,
        title: 'Przejęte przez firmę B',
        rationale: 'Przejęte przez firmę B.',
        actions: problem.actions.slice(0, 1).map((action) => ({
          ...action,
          content: 'Przejęte przez firmę B.',
        })),
      }))

    const { error } = await ownerB.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: 'Przejęte przez firmę B.',
      p_problems: payload,
    })

    expect(error?.code).toBe('42501')

    // The decisive assertion: byte-for-byte identical, including
    // original_content (the snapshot runs BEFORE the id checks, so a
    // transaction that aborts later must take it with it) and updated_at (the
    // touch trigger must not have fired either).
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it('refuses a plan id that never existed with the same error, giving no oracle', async () => {
    // A foreign plan id and a nonexistent one are refused identically, which is
    // the same posture /dashboard/plans/[planId] takes with notFound(). A
    // distinguishable "not found" would turn the edit endpoint into a probe for
    // which plan ids exist.
    const { error: foreign } = await ownerB.db.rpc('update_action_plan', {
      p_plan_id: (
        await seedPlan(ownerA, {
          summary: 'Plan do sondowania.',
          problems: [
            {
              title: 'Problem',
              rationale: 'Uzasadnienie.',
              submissionIds: [subA[0]],
              actions: ['Krok.'],
            },
          ],
        })
      ).id,
      p_summary: 'Nie powinno się zapisać.',
      p_problems: [
        { id: randomUUID(), title: 'X', rationale: 'X', actions: [{ id: randomUUID(), content: 'X' }] },
      ],
    })

    const { error: absent } = await ownerB.db.rpc('update_action_plan', {
      p_plan_id: randomUUID(),
      p_summary: 'Nie powinno się zapisać.',
      p_problems: [
        { id: randomUUID(), title: 'X', rationale: 'X', actions: [{ id: randomUUID(), content: 'X' }] },
      ],
    })

    expect(foreign?.code).toBe('42501')
    expect(absent?.code).toBe('42501')
  })

  it('denies anon execution of update_action_plan at the GRANT layer', async () => {
    // The 20260814134807 regression, re-run against the new function. As first
    // written, save_action_plan()'s migration ended with `revoke all ... from
    // public` and its comment claimed the RPC was owner-only. It was not:
    // Supabase's default privileges grant EXECUTE on new functions DIRECTLY to
    // anon, and a direct grant to a named role survives a revoke aimed at the
    // PUBLIC pseudo-role. Anon reached the BODY of a security-definer function
    // and was stopped only by its null-company check — the second layer doing
    // the first's job.
    //
    // Hence the message assertion, which is the whole point: both refusals
    // report 42501, so the code alone cannot tell "anon may not call this
    // function" from "anon called it and it raised". Only the text can.
    const anon = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { error } = await anon.rpc('update_action_plan', {
      p_plan_id: randomUUID(),
      p_summary: 'Edycja od nikogo.',
      p_problems: [
        { id: randomUUID(), title: 'X', rationale: 'X', actions: [{ id: randomUUID(), content: 'X' }] },
      ],
    })

    // Logged before asserting because the PostgREST-side shape of a missing
    // EXECUTE grant is the one detail in this chain that reading the repo
    // cannot settle — if it ever changes, the run output names the replacement
    // instead of only saying "expected 42501".
    console.info('[anon rpc] rejection as received by supabase-js:', JSON.stringify(error))
    expect(error?.code).toBe('42501')
    expect(error?.message).toContain('permission denied for function')
    expect(error?.message).not.toContain('no company for the calling user')
  })
})

/**
 * Id verification. Removal is "this id was not in the payload", which makes the
 * id set the load-bearing part of an edit: an unverified id would let a payload
 * re-parent a step, or reach a sibling plan's rows through a function that
 * already bypassed RLS to get here.
 */
describe('update_action_plan id verification', () => {
  it("refuses a problem id belonging to a different plan of the SAME owner", async () => {
    // Same company, so the tenancy check passes — this is the second, narrower
    // predicate doing its own job. Nothing about owning two plans should let an
    // edit of one reach into the other.
    const [target, other] = await Promise.all([
      seedPlan(ownerA, {
        summary: 'Plan docelowy.',
        problems: [
          {
            title: 'Problem planu docelowego',
            rationale: 'Uzasadnienie.',
            submissionIds: [subA[0]],
            actions: ['Krok.'],
          },
        ],
      }),
      seedPlan(ownerA, {
        summary: 'Plan obcy.',
        problems: [
          {
            title: 'Problem obcego planu',
            rationale: 'Uzasadnienie.',
            submissionIds: [subA[1]],
            actions: ['Krok.'],
          },
        ],
      }),
    ])
    const before = await readPlan(target.id)

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: target.id,
      p_summary: 'Nie powinno się zapisać.',
      p_problems: toPayload(other),
    })

    expect(error?.code).toBe('23514')
    expect(await readPlan(target.id)).toEqual(before)
    // ...and the plan whose ids were borrowed is untouched too.
    expect(await readPlan(other.id)).toEqual(other)
  })

  it('refuses an action id belonging to a SIBLING problem of the same plan', async () => {
    // The re-parenting case. Both ids are this plan's and this company's; only
    // the per-problem scoping of the action check refuses it. Without that
    // scoping an edit could silently move a step from one problem to another,
    // and a plan whose steps are attached to the wrong problems is exactly the
    // "powiązanych z wyłonionymi problemami" guarantee failing quietly.
    const plan = await seedPlan(ownerA, {
      summary: 'Plan z dwoma problemami.',
      problems: [
        {
          title: 'Pierwszy',
          rationale: 'Uzasadnienie pierwszego.',
          submissionIds: [subA[0]],
          actions: ['Krok pierwszego.'],
        },
        {
          title: 'Drugi',
          rationale: 'Uzasadnienie drugiego.',
          submissionIds: [subA[1]],
          actions: ['Krok drugiego.'],
        },
      ],
    })
    const before = await readPlan(plan.id)

    const payload = toPayload(plan)
    // Problem 1 claims problem 2's action id.
    payload[0].actions = [{ id: plan.problems[1].actions[0].id, content: 'Przeniesiony krok.' }]

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })

    expect(error?.code).toBe('23514')
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it('refuses a payload repeating one problem id', async () => {
    // count(distinct ...) versus count(*): a duplicated id is a malformed
    // payload (22023), not a tenancy question — and it would otherwise reach
    // the renumber, where two array positions claim one row and the last write
    // silently wins.
    const plan = await seedFourProblemPlan()
    const before = await readPlan(plan.id)

    const payload = toPayload(plan)
    payload[1].id = payload[0].id

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })

    expect(error?.code).toBe('22023')
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it('refuses a payload whose problem carries no id at all', async () => {
    // count(distinct ...) ignores NULLs, so a missing `id` fails the same
    // check a duplicate does. This is the shape a client that tried to ADD a
    // problem would post — and adding is explicitly not something editing does,
    // because an owner-authored problem cites nothing.
    const plan = await seedFourProblemPlan()
    const before = await readPlan(plan.id)

    const payload: Record<string, unknown>[] = toPayload(plan)
    delete payload[2].id

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })

    expect(error?.code).toBe('22023')
    expect(await readPlan(plan.id)).toEqual(before)
  })
})

/**
 * The floors and the ceilings. Both ends are named in one statement inside the
 * function so they cannot drift, and both ends matter: the floor is what stops
 * an edit from emptying a plan through the removal path, the ceiling is what
 * stops a payload the app could never produce from being applied anyway.
 */
describe('update_action_plan floors and bounds', () => {
  it('refuses an edit that removes the last problem', async () => {
    // Removing every problem is deleting the plan by another name — with no
    // confirmation, no revalidation and a header left behind claiming to be a
    // plan. FR-014 has a delete for that, and it is a different button.
    const plan = await seedPlan(ownerA, {
      summary: 'Plan z jednym problemem.',
      problems: [
        {
          title: 'Jedyny problem',
          rationale: 'Uzasadnienie.',
          submissionIds: [subA[0]],
          actions: ['Krok.'],
        },
      ],
    })
    const before = await readPlan(plan.id)

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: [],
    })

    expect(error?.code).toBe('22023')
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it("refuses an edit that removes a problem's last action", async () => {
    // "Plan działań" without działania is a summary, and FR-011 asks for both —
    // the same floor save_action_plan() enforces at generation time, held under
    // editing.
    const plan = await seedPlan(ownerA, {
      summary: 'Plan, którego problem ma jeden krok.',
      problems: [
        {
          title: 'Problem z jednym krokiem',
          rationale: 'Uzasadnienie.',
          submissionIds: [subA[0]],
          actions: ['Jedyny krok.'],
        },
      ],
    })
    const before = await readPlan(plan.id)

    const payload = toPayload(plan)
    payload[0].actions = []

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })

    expect(error?.code).toBe('22023')
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it(`refuses more than ${PLAN_PROBLEMS_MAX} problems`, async () => {
    // The ceiling is checked before any id is resolved, which is why padding
    // with invented ids is enough to exercise it: an over-long payload is
    // refused as a bound violation (22023), never as a bad id (23514).
    const plan = await seedFourProblemPlan()
    const before = await readPlan(plan.id)

    const payload = [
      ...toPayload(plan),
      ...Array.from({ length: PLAN_PROBLEMS_MAX + 1 - plan.problems.length }, () => ({
        id: randomUUID(),
        title: 'Wypełniacz',
        rationale: 'Wypełniacz.',
        actions: [{ id: randomUUID(), content: 'Wypełniacz.' }],
      })),
    ]
    expect(payload).toHaveLength(PLAN_PROBLEMS_MAX + 1)

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })

    expect(error?.code).toBe('22023')
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it(`refuses more than ${PROBLEM_ACTIONS_MAX} actions on one problem`, async () => {
    const plan = await seedFourProblemPlan()
    const before = await readPlan(plan.id)

    const payload = toPayload(plan)
    payload[0].actions = Array.from({ length: PROBLEM_ACTIONS_MAX + 1 }, () => ({
      id: randomUUID(),
      content: 'Wypełniacz.',
    }))

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })

    expect(error?.code).toBe('22023')
    expect(await readPlan(plan.id)).toEqual(before)
  })
})

/**
 * The renumber. `unique (plan_id, rank)` plus `check (rank > 0)` rules out the
 * usual negate-then-renumber trick, so the function offsets by +1000 first and
 * assigns final values second. Remove that first pass and these two cases fail
 * with 23505 — on removing any problem but the last, which is the exact edit
 * this slice exists for.
 */
describe('update_action_plan renumbering', () => {
  it('leaves rank contiguous from 1 after a MIDDLE problem is removed', async () => {
    const plan = await seedFourProblemPlan()

    const payload = toPayload(plan).filter((_, index) => index !== 1)

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })
    expect(error).toBeNull()

    const after = await readPlan(plan.id)
    expect(after!.problems.map((problem) => problem.rank)).toEqual([1, 2, 3])
    // The order is the payload's order, and rank follows it — the surviving
    // problems close ranks rather than keeping a gap where #2 was.
    expect(after!.problems.map((problem) => problem.title)).toEqual([
      'Problem 1',
      'Problem 3',
      'Problem 4',
    ])
  })

  it('leaves position contiguous from 1 after a MIDDLE action is removed', async () => {
    const plan = await seedPlan(ownerA, {
      summary: 'Plan, w którym znika środkowy krok.',
      problems: [
        {
          title: 'Problem z trzema krokami',
          rationale: 'Uzasadnienie.',
          submissionIds: [subA[0]],
          actions: ['Krok pierwszy.', 'Krok drugi.', 'Krok trzeci.'],
        },
      ],
    })

    const payload = toPayload(plan)
    payload[0].actions = payload[0].actions.filter((_, index) => index !== 1)

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: payload,
    })
    expect(error).toBeNull()

    const after = await readPlan(plan.id)
    expect(after!.problems[0].actions.map((action) => action.position)).toEqual([1, 2])
    expect(after!.problems[0].actions.map((action) => action.content)).toEqual([
      'Krok pierwszy.',
      'Krok trzeci.',
    ])
  })

  it('renumbers correctly when the removal is combined with a reorderless rewrite', async () => {
    // Removal and rewriting in one payload — the ordinary edit. The offset pass
    // has to survive rows whose text changes in the same statement that assigns
    // their final rank.
    const plan = await seedFourProblemPlan()

    const payload = toPayload(plan)
      .filter((_, index) => index !== 0)
      .map((problem, index) => ({
        ...problem,
        title: `Przepisany ${index + 1}`,
        actions: problem.actions
          .slice(0, 1)
          .map((action) => ({ ...action, content: `Przepisany krok ${index + 1}.` })),
      }))

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: 'Przepisane podsumowanie.',
      p_problems: payload,
    })
    expect(error).toBeNull()

    const after = await readPlan(plan.id)
    expect(after!.problems.map((problem) => problem.rank)).toEqual([1, 2, 3])
    expect(after!.problems.map((problem) => problem.title)).toEqual([
      'Przepisany 1',
      'Przepisany 2',
      'Przepisany 3',
    ])
    for (const problem of after!.problems) {
      expect(problem.actions.map((action) => action.position)).toEqual([1])
    }
  })
})

describe('update_action_plan removal cascades', () => {
  it("takes the removed problem's actions and citations with it", async () => {
    // The removed problem's rows must not survive as orphans: an action with no
    // problem is unreachable, and a citation with no problem is a grounding
    // claim for something the plan no longer says.
    const plan = await seedFourProblemPlan()
    const removed = plan.problems[1]
    expect(removed.actions).toHaveLength(2)
    expect(removed.citations).toHaveLength(1)

    const { error } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: plan.summary,
      p_problems: toPayload(plan).filter((problem) => problem.id !== removed.id),
    })
    expect(error).toBeNull()

    const [{ data: problemRows }, { data: actionRows }, { data: citationRows }] = await Promise.all(
      [
        admin.from('plan_problems').select('id').eq('id', removed.id),
        admin.from('plan_actions').select('id').eq('problem_id', removed.id),
        admin.from('plan_problem_submissions').select('submission_id').eq('problem_id', removed.id),
      ]
    )
    expect(problemRows).toHaveLength(0)
    expect(actionRows).toHaveLength(0)
    expect(citationRows).toHaveLength(0)

    // The submission itself is untouched — the citation goes, the customer's
    // words stay.
    const { data: submission } = await admin
      .from('submissions')
      .select('id')
      .eq('id', removed.citations[0])
    expect(submission).toHaveLength(1)
  })
})

/**
 * The snapshot. `original_content is null` is both the never-edited flag and the
 * write guard, and the second-edit case is the one that matters: an
 * unconditional write reads correct on any single edit and silently turns "what
 * the model produced" into "what it looked like before the last change".
 */
describe('update_action_plan original_content snapshot', () => {
  it('is null before the first edit, holds the pre-edit plan after it, and never changes again', async () => {
    const plan = await seedPlan(ownerA, {
      summary: 'Podsumowanie tak, jak napisał je model.',
      problems: [
        {
          title: 'Tytuł od modelu',
          rationale: 'Uzasadnienie od modelu.',
          submissionIds: [subA[0]],
          actions: ['Pierwszy krok od modelu.', 'Drugi krok od modelu.'],
        },
        {
          title: 'Drugi tytuł od modelu',
          rationale: 'Drugie uzasadnienie od modelu.',
          submissionIds: [subA[1]],
          actions: ['Trzeci krok od modelu.'],
        },
      ],
    })

    // A saved-but-unedited plan reads as "not edited", which is what the list
    // page's "Edited" marker keys on.
    expect(plan.original_content).toBeNull()

    const firstPayload = toPayload(plan)
    firstPayload[0].title = 'Tytuł poprawiony przez właściciela'
    firstPayload[0].actions[0].content = 'Pierwszy krok poprawiony.'

    const { error: firstError } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: 'Podsumowanie poprawione przez właściciela.',
      p_problems: firstPayload,
    })
    expect(firstError).toBeNull()

    const afterFirst = await readPlan(plan.id)
    // Built from the STORED ROWS, not from the payload: the point is to record
    // what the model produced, and the payload is what the client CLAIMS it
    // produced. Shape and order both matter — problems by rank, actions by
    // position — because PlanOriginalSchema parses this on the way out.
    expect(afterFirst!.original_content).toEqual({
      summary: 'Podsumowanie tak, jak napisał je model.',
      problems: [
        {
          title: 'Tytuł od modelu',
          rationale: 'Uzasadnienie od modelu.',
          actions: ['Pierwszy krok od modelu.', 'Drugi krok od modelu.'],
        },
        {
          title: 'Drugi tytuł od modelu',
          rationale: 'Drugie uzasadnienie od modelu.',
          actions: ['Trzeci krok od modelu.'],
        },
      ],
    })

    // The second edit, including a removal — the state an unconditional write
    // would record as "the original".
    const secondPayload = toPayload(afterFirst!).filter((_, index) => index !== 1)
    secondPayload[0].title = 'Tytuł poprawiony po raz drugi'

    const { error: secondError } = await ownerA.db.rpc('update_action_plan', {
      p_plan_id: plan.id,
      p_summary: 'Podsumowanie poprawione po raz drugi.',
      p_problems: secondPayload,
    })
    expect(secondError).toBeNull()

    const afterSecond = await readPlan(plan.id)
    expect(afterSecond!.summary).toBe('Podsumowanie poprawione po raz drugi.')
    expect(afterSecond!.problems).toHaveLength(1)
    // A snapshot, not a trail. The owner compares against the generation, never
    // against their own previous edit.
    expect(afterSecond!.original_content).toEqual(afterFirst!.original_content)
  })
})

/**
 * S-04's one new privilege, in context. The migration grants `delete` on
 * action_plans and nothing else; re-proving the rest of the surface here is what
 * would catch a future migration that "just adds an update grant" to make an
 * editor simpler and takes the floors, the renumber and the atomicity with it.
 */
describe('plan tables stay write-closed for authenticated after S-04', () => {
  it('refuses a direct UPDATE on all four plan tables', async () => {
    // action_plans included: even a column-scoped `update (summary)` would be
    // wrong, because a plan edit is a multi-table transaction that a sequence of
    // PostgREST PATCHes cannot make atomic.
    const attempts: Array<[string, Record<string, unknown>, string]> = [
      ['action_plans', { summary: 'Przepisane.' }, 'id'],
      ['plan_problems', { title: 'Przepisane.' }, 'id'],
      ['plan_actions', { content: 'Przepisane.' }, 'id'],
      ['plan_problem_submissions', { submission_id: subA[0] }, 'problem_id'],
    ]

    for (const [table, patch, filterColumn] of attempts) {
      const { error } = await ownerA.db
        .from(table)
        .update(patch)
        .neq(filterColumn, '00000000-0000-0000-0000-000000000000')
      expect(error?.code, `UPDATE on ${table}`).toBe('42501')
    }
  })

  it('refuses a direct DELETE on every plan CHILD table', async () => {
    // A row-by-row delete would strip a plan past the floors update_action_plan
    // enforces and leave rank/position with gaps. Removal is a consequence of
    // posting a new desired state, never a call of its own.
    for (const [table, filterColumn] of Object.entries(CHILD_TABLE_FILTER_COLUMN)) {
      const { error } = await ownerA.db
        .from(table)
        .delete()
        .neq(filterColumn, '00000000-0000-0000-0000-000000000000')
      expect(error?.code, `DELETE on ${table}`).toBe('42501')
    }
  })

  it('refuses a direct INSERT into every plan table', async () => {
    // Editing never creates. Nothing in S-04 opens an insert path, and an
    // owner-authored problem would cite nothing — an ungrounded row in the table
    // whose entire purpose is grounding.
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['action_plans', { company_id: ownerA.companyId, summary: 'Wpisany ręcznie.' }],
      ['plan_problems', { plan_id: randomUUID(), rank: 1, title: 'Ręczny', rationale: 'Ręczny' }],
      ['plan_actions', { problem_id: randomUUID(), position: 1, content: 'Ręczny' }],
      ['plan_problem_submissions', { problem_id: randomUUID(), submission_id: subA[0] }],
    ]

    for (const [table, row] of attempts) {
      const { error } = await ownerA.db.from(table).insert(row)
      expect(error?.code, `INSERT into ${table}`).toBe('42501')
    }
  })
})

/**
 * The delete grant itself (FR-014). Unlike every other write in this slice it
 * is a plain PostgREST call rather than an RPC, because a whole-plan delete has
 * no invariant to protect: the children go with the S-03 cascades.
 *
 * Which makes its SCOPING the whole story, and its failure mode a silent one —
 * a delete matching zero rows is not an error.
 */
describe('action_plans delete', () => {
  it("removes an owner's own plan and everything hanging off it", async () => {
    const plan = await seedFourProblemPlan()
    const problemIds = plan.problems.map((problem) => problem.id)

    const { data: deleted, error } = await ownerA.db
      .from('action_plans')
      .delete()
      .eq('id', plan.id)
      .eq('company_id', ownerA.companyId)
      .select('id')

    expect(error).toBeNull()
    // `.select('id')` is what makes the delete observable at all — without it a
    // zero-row delete and a successful one are indistinguishable to the caller.
    expect(deleted).toHaveLength(1)

    expect(await readPlan(plan.id)).toBeNull()

    const [{ data: problemRows }, { data: actionRows }, { data: citationRows }] = await Promise.all(
      [
        admin.from('plan_problems').select('id').in('id', problemIds),
        admin.from('plan_actions').select('id').in('problem_id', problemIds),
        admin.from('plan_problem_submissions').select('submission_id').in('problem_id', problemIds),
      ]
    )
    expect(problemRows).toHaveLength(0)
    expect(actionRows).toHaveLength(0)
    expect(citationRows).toHaveLength(0)

    // Submissions are not plan children. Deleting a plan must not cost the
    // owner the customer feedback it was generated from.
    const { count } = await admin
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', ownerA.companyId)
    expect(count).toBe(subA.length)
  })

  it("matches zero rows when owner B deletes owner A's plan, leaving it intact", async () => {
    // The silent shape: `select` is granted and `delete` is granted, so RLS —
    // not a privilege error — is what refuses this. The companion service-role
    // read is what distinguishes "the policy filtered it" from "it worked".
    const plan = await seedPlan(ownerA, {
      summary: 'Plan firmy A, którego firma B nie może usunąć.',
      problems: [
        {
          title: 'Problem firmy A',
          rationale: 'Uzasadnienie.',
          submissionIds: [subA[0]],
          actions: ['Krok.'],
        },
      ],
    })
    const before = await readPlan(plan.id)

    const { data: deleted, error } = await ownerB.db
      .from('action_plans')
      .delete()
      .eq('id', plan.id)
      .select('id')

    expect(error).toBeNull()
    expect(deleted).toEqual([])
    expect(await readPlan(plan.id)).toEqual(before)
  })

  it("refuses owner B a delete even when they name owner A's company_id", async () => {
    // The unfiltered/mis-filtered shape: PostgREST would happily accept a delete
    // whose only filter is company_id, so a policy keyed on the wrong column
    // would let one owner clear another's entire plan history in one request.
    const plan = await seedPlan(ownerA, {
      summary: 'Plan firmy A, cel masowego usunięcia.',
      problems: [
        {
          title: 'Problem firmy A',
          rationale: 'Uzasadnienie.',
          submissionIds: [subA[0]],
          actions: ['Krok.'],
        },
      ],
    })

    const { data: deleted, error } = await ownerB.db
      .from('action_plans')
      .delete()
      .eq('company_id', ownerA.companyId)
      .select('id')

    expect(error).toBeNull()
    expect(deleted).toEqual([])

    const { data: rows } = await admin.from('action_plans').select('id').eq('id', plan.id)
    expect(rows).toHaveLength(1)
  })
})
