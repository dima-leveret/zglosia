import { randomUUID } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireLocalDb } from './support/require-local-db'

/**
 * Phase 2 gate for S-03: the executable half of
 * 20260814132833_generate_action_plan.sql.
 *
 * Two guarantees in that migration are claimed to hold against a caller who
 * skips the application entirely and posts straight at PostgREST with the anon
 * key and their own JWT. Prose in a migration cannot demonstrate either one:
 *
 *   1. GROUNDING (the anti-hallucination NFR). save_action_plan() refuses any
 *      citation that does not resolve to a submission of the CALLING company,
 *      and aborts the whole transaction rather than saving a thinner plan.
 *   2. WRITES ARE RPC-ONLY. The four plan tables carry `select` and nothing
 *      else for `authenticated`, so the grounding check cannot be walked around
 *      by inserting rows directly.
 *
 * This suite is also the compensating control for Progress item 1.1, which was
 * NOT run: there is no Docker runtime on the implementing machine, so the
 * migration was never applied to an empty local database via `supabase db
 * reset`. The linked project auto-exposes new tables, which means a missing
 * `revoke all` would look perfectly correct there while silently granting ALL
 * to anon and authenticated. Every denial below is the behavioural evidence
 * that the revoke-then-grant block actually took effect — read them as the
 * reason 1.1's absence is survivable, not as belt-and-braces.
 *
 * Style follows tests/schema.test.ts and tests/isolation.test.ts: a positive
 * control first (without it, every denial would also pass on a feature nobody
 * can use at all), then each denial on its own specific SQLSTATE. An empty
 * array is never accepted as evidence of a denial — it is also what a GRANTED
 * select with no matching policy returns, and the two mean opposite things.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing Supabase env. tests/plans.test.ts needs NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (loaded from .env.local).'
  )
}

requireLocalDb(url, 'tests/plans.test.ts')

/** Service-role client: bypasses RLS. Test-only — never an owner-facing read. */
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** 10 generations per company per day — enforce_plan_generation_rate(). */
const PLAN_GENERATION_CAP = 10

/**
 * The four plan tables. All four refuse INSERT and UPDATE from `authenticated`
 * — every structural write goes through save_action_plan() or, since S-04,
 * update_action_plan(). DELETE is the one exception: S-04 grants it on
 * action_plans alone (see the child-table case below).
 */
const PLAN_TABLES = [
  'action_plans',
  'plan_problems',
  'plan_actions',
  'plan_problem_submissions',
] as const

/**
 * A column that really exists on each plan table, for the write denials to
 * filter on. plan_problem_submissions is a pure join table with no surrogate
 * key, so a shared `id` filter would fail with 42703 (undefined_column) before
 * Postgres ever consults the privilege — and the test would then pass without
 * having proven anything about the grant.
 */
const PLAN_TABLE_FILTER_COLUMN: Record<string, string> = {
  action_plans: 'id',
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
  const email = `plans-${label}-${randomUUID()}@example.com`
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

/** How many plans a company holds, read past RLS. */
async function countPlans(companyId: string): Promise<number> {
  const { count, error } = await admin
    .from('action_plans')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (error) throw error
  return count ?? 0
}

let ownerA: Owner
let ownerB: Owner
/** Three of owner A's submissions, the raw material every plan below cites. */
let subA: string[]
/** One of owner B's — the id that must never be citable by owner A. */
let subB: string

beforeAll(async () => {
  ;[ownerA, ownerB] = await Promise.all([createOwner('a'), createOwner('b')])

  const [ownerASubmissions, ownerBSubmissions] = await Promise.all([
    seedSubmissions(ownerA.companyId, [
      'Czekałem 20 minut na kawę.',
      'Kolejka do kasy była ogromna.',
      'Kawa była zimna.',
    ]),
    seedSubmissions(ownerB.companyId, ['Zgłoszenie firmy B. Firma A nie może go cytować.']),
  ])
  subA = ownerASubmissions
  subB = ownerBSubmissions[0]
})

afterAll(async () => {
  // companies.owner_id is ON DELETE CASCADE, and action_plans /
  // plan_generations cascade from companies, so deleting the users clears every
  // fixture row this suite wrote — a second consecutive run starts empty.
  await Promise.all(
    [ownerA, ownerB].filter(Boolean).map(async (owner) => {
      await owner.db.auth.signOut()
      await admin.auth.admin.deleteUser(owner.userId)
    })
  )
})

describe('save_action_plan round trip', () => {
  it('saves a plan and reads back its problems, actions and citations', async () => {
    // The positive control. Without it every denial in this file would also
    // pass on a feature that is broken outright — a missing execute grant, a
    // wrong argument name — and the suite would report a perfectly locked-down
    // plan surface that nobody can actually save a plan to.
    const summary = 'Klienci najczęściej skarżą się na czas obsługi i temperaturę kawy.'
    const { data: planId, error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: summary,
      p_problems: [
        {
          title: 'Długi czas oczekiwania',
          rationale: 'Dwa zgłoszenia wprost mówią o czekaniu i kolejce.',
          submissionIds: [subA[0], subA[1]],
          actions: ['Otwórz drugą kasę w godzinach szczytu.', 'Wprowadź zamówienia mobilne.'],
        },
        {
          title: 'Zimna kawa',
          rationale: 'Jedno zgłoszenie dotyczy temperatury napoju.',
          submissionIds: [subA[2]],
          actions: ['Skalibruj ekspres i sprawdzaj temperaturę co rano.'],
        },
      ],
    })

    expect(error).toBeNull()
    expect(typeof planId).toBe('string')

    const { data: plan, error: planError } = await ownerA.db
      .from('action_plans')
      .select('id, company_id, summary, created_at')
      .eq('id', planId)
      .single()
    expect(planError).toBeNull()
    expect(plan).toMatchObject({ company_id: ownerA.companyId, summary })

    const { data: problems, error: problemsError } = await ownerA.db
      .from('plan_problems')
      .select('id, rank, title, rationale')
      .eq('plan_id', planId)
      .order('rank')
    expect(problemsError).toBeNull()
    expect(problems).toHaveLength(2)
    // rank is assigned from ARRAY ORDER inside the function, never taken from
    // the payload — so it cannot arrive duplicated or with gaps.
    expect(problems!.map((row) => row.rank)).toEqual([1, 2])
    expect(problems![0].title).toBe('Długi czas oczekiwania')

    const problemIds = problems!.map((row) => row.id)

    const { data: actions, error: actionsError } = await ownerA.db
      .from('plan_actions')
      .select('problem_id, position, content')
      .in('problem_id', problemIds)
      .order('position')
    expect(actionsError).toBeNull()
    expect(actions).toHaveLength(3)
    // Same reasoning as rank: position comes from the array's ordinality.
    expect(
      actions!.filter((row) => row.problem_id === problemIds[0]).map((row) => row.position)
    ).toEqual([1, 2])

    const { data: citations, error: citationsError } = await ownerA.db
      .from('plan_problem_submissions')
      .select('problem_id, submission_id')
      .in('problem_id', problemIds)
    expect(citationsError).toBeNull()
    // The NFR, read back: three citations, every one of them a real submission
    // of this company.
    expect(citations).toHaveLength(3)
    expect(citations!.map((row) => row.submission_id).sort()).toEqual([...subA].sort())
  })

  it('collapses a duplicated citation to one row rather than refusing the save', async () => {
    // The function counts DISTINCT ids before comparing against rows inserted.
    // A model citing the same submission twice is sloppy, not ungrounded, and
    // counting raw array length would turn that into a refused save — so this
    // case pins which of the two the mismatch check is allowed to fire on.
    const { data: planId, error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Duplikat cytatu nie jest halucynacją.',
      p_problems: [
        {
          title: 'Powtórzony cytat',
          rationale: 'To samo zgłoszenie wskazane dwukrotnie.',
          submissionIds: [subA[0], subA[0]],
          actions: ['Nic do zrobienia — to test.'],
        },
      ],
    })

    expect(error).toBeNull()

    const { data: problems, error: problemsError } = await admin
      .from('plan_problems')
      .select('id')
      .eq('plan_id', planId)
    expect(problemsError).toBeNull()

    const { data: citations, error: citationsError } = await admin
      .from('plan_problem_submissions')
      .select('submission_id')
      .eq('problem_id', problems![0].id)
    expect(citationsError).toBeNull()
    expect(citations).toHaveLength(1)
  })
})

/**
 * The grounding boundary. save_action_plan() is `security definer`, so it runs
 * as its owner and BYPASSES RLS on public.submissions — the company predicate
 * inside the function is the only thing scoping the citation lookup. These
 * cases are what prove that predicate is really there, since a version of the
 * function without it would pass every other test in this file.
 */
describe('save_action_plan grounding', () => {
  it("refuses a citation naming another company's submission, and writes nothing", async () => {
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Plan cytujący cudze zgłoszenie.',
      p_problems: [
        {
          title: 'Cudzy cytat',
          rationale: 'Cytuje zgłoszenie należące do firmy B.',
          // subB exists and is a perfectly valid uuid — it simply is not owner
          // A's. The FK alone would happily accept it; the company filter is
          // what refuses it.
          submissionIds: [subB],
          actions: ['Nie powinno się zapisać.'],
        },
      ],
    })

    expect(error?.code).toBe('23514')

    // The decisive assertion: the header and everything under it were rolled
    // back. A silently thinner plan — saved, minus the bad citation — is the
    // failure mode this whole design exists to prevent.
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })

  it('refuses a MIXTURE of valid and foreign citations, saving neither', async () => {
    // The realistic shape of the attack: one real citation to make the problem
    // look grounded, one forged. A check that fired only when ZERO citations
    // resolved would pass this and save a plan whose grounding is half fiction.
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Plan częściowo ugruntowany.',
      p_problems: [
        {
          title: 'Pół prawdy',
          rationale: 'Jeden cytat prawdziwy, jeden cudzy.',
          submissionIds: [subA[0], subB],
          actions: ['Nie powinno się zapisać.'],
        },
      ],
    })

    expect(error?.code).toBe('23514')
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })

  it('refuses a citation naming a submission that does not exist at all', async () => {
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Plan cytujący zmyślone zgłoszenie.',
      p_problems: [
        {
          title: 'Zmyślony cytat',
          rationale: 'Cytuje uuid, którego nie ma w bazie.',
          submissionIds: [randomUUID()],
          actions: ['Nie powinno się zapisać.'],
        },
      ],
    })

    expect(error?.code).toBe('23514')
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })

  it('refuses an empty problem list', async () => {
    // A plan with zero problems is not a plan. The Server Action refuses to
    // return one; this is the independent second layer.
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Plan bez problemów.',
      p_problems: [],
    })

    expect(error?.code).toBe('22023')
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })

  it('refuses a problem list longer than PLAN_PROBLEMS_MAX', async () => {
    // The other half of the same range check. PLAN_PROBLEMS_MAX = 8 lives in
    // src/lib/plan-schema.ts, and Zod is not a boundary — a direct PostgREST
    // call skips it, which is exactly the caller this bound exists for.
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Za dużo problemów.',
      p_problems: Array.from({ length: 9 }, (_, index) => ({
        title: `Problem ${index + 1}`,
        rationale: 'Wypełniacz, żeby przekroczyć limit.',
        submissionIds: [subA[0]],
        actions: ['Nie powinno się zapisać.'],
      })),
    })

    expect(error?.code).toBe('22023')
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })

  it('refuses a problem carrying no citations', async () => {
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Problem bez cytatu.',
      p_problems: [
        {
          title: 'Bez podstawy',
          rationale: 'Nie wskazuje żadnego zgłoszenia.',
          submissionIds: [],
          actions: ['Nie powinno się zapisać.'],
        },
      ],
    })

    expect(error?.code).toBe('22023')
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })

  it('refuses a problem carrying no actions', async () => {
    // "Plan działań" without działania is a summary, and FR-011 asks for both.
    const before = await countPlans(ownerA.companyId)

    const { error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Problem bez działań.',
      p_problems: [
        {
          title: 'Bez kroków',
          rationale: 'Opisuje problem, nie proponuje nic.',
          submissionIds: [subA[0]],
          actions: [],
        },
      ],
    })

    expect(error?.code).toBe('22023')
    expect(await countPlans(ownerA.companyId)).toBe(before)
  })
})

/**
 * "Writes are RPC-only" is a claim about GRANTS, and grants are exactly what a
 * repo read cannot verify — the linked project auto-exposes new tables, so
 * without the revoke block these inserts would succeed while the migration text
 * still said they could not. Every case here fails at the privilege layer with
 * 42501, before RLS is ever consulted.
 */
describe('plan tables are read-only for authenticated', () => {
  it('refuses a direct INSERT into every plan table', async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['action_plans', { company_id: ownerA.companyId, summary: 'Wpisany ręcznie.' }],
      [
        'plan_problems',
        { plan_id: randomUUID(), rank: 1, title: 'Ręczny', rationale: 'Ręczny' },
      ],
      ['plan_actions', { problem_id: randomUUID(), position: 1, content: 'Ręczny' }],
      ['plan_problem_submissions', { problem_id: randomUUID(), submission_id: subA[0] }],
    ]

    for (const [table, row] of attempts) {
      const { error } = await ownerA.db.from(table).insert(row)
      // 42501 and not 23503: the grant refuses the statement before the foreign
      // key on the invented parent id is ever checked. That ordering is the
      // assertion — a table with an insert grant would report 23503 here.
      expect(error?.code, `INSERT into ${table}`).toBe('42501')
    }
  })

  it('refuses an UPDATE on every plan table', async () => {
    // The filter column differs per table on purpose: plan_problem_submissions
    // is a pure join table with no `id`, and naming a column that does not
    // exist would fail with 42703 long before the privilege layer is reached —
    // a green test proving nothing.
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['action_plans', { summary: 'Przepisane.' }],
      ['plan_problems', { title: 'Przepisane.' }],
      ['plan_actions', { content: 'Przepisane.' }],
      ['plan_problem_submissions', { submission_id: subA[0] }],
    ]

    for (const [table, patch] of attempts) {
      const { error } = await ownerA.db
        .from(table)
        .update(patch)
        .neq(PLAN_TABLE_FILTER_COLUMN[table], '00000000-0000-0000-0000-000000000000')
      expect(error?.code, `UPDATE on ${table}`).toBe('42501')
    }
  })

  it('refuses a DELETE on every plan CHILD table', async () => {
    // action_plans left this set in S-04. FR-014 needs a whole-plan delete, and
    // 20260815160000_saved_plans_management.sql grants it — a header delete
    // cannot corrupt anything, because the children go with the S-03 cascades.
    // Its scoping (an owner deletes their own; owner B's delete of owner A's
    // plan matches zero rows) is asserted in tests/plan-editing.test.ts.
    //
    // The three CHILD tables keep denying, and that is the load-bearing half:
    // a row-by-row delete would strip a plan past the floors
    // update_action_plan() enforces and leave `rank`/`position` with gaps. This
    // case is what keeps a future "just add delete" migration honest about
    // crossing that line.
    for (const table of PLAN_TABLES.filter((t) => t !== 'action_plans')) {
      const { error } = await ownerA.db
        .from(table)
        .delete()
        .neq(PLAN_TABLE_FILTER_COLUMN[table], '00000000-0000-0000-0000-000000000000')
      expect(error?.code, `DELETE on ${table}`).toBe('42501')
    }
  })
})

/**
 * The isolation half (PRD FR-001, NFR "dane jednej firmy są nieosiągalne dla
 * innej"), carried onto the five tables S-03 adds. Unlike the write denials
 * above these are SILENT — select is granted, so a cross-tenant read succeeds
 * and returns nothing. The companion service-role read is what distinguishes
 * "RLS filtered it" from "the row was never there".
 */
describe('plan isolation between companies', () => {
  let planId: string
  let problemId: string

  beforeAll(async () => {
    const { data, error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Plan firmy A. Firma B nie może go zobaczyć.',
      p_problems: [
        {
          title: 'Prywatny problem firmy A',
          rationale: 'Widoczny wyłącznie dla firmy A.',
          submissionIds: [subA[0]],
          actions: ['Krok widoczny wyłącznie dla firmy A.'],
        },
      ],
    })
    if (error) throw error
    planId = data as string

    const { data: problems, error: problemsError } = await admin
      .from('plan_problems')
      .select('id')
      .eq('plan_id', planId)
    if (problemsError) throw problemsError
    problemId = problems![0].id
  })

  it("denies owner B a targeted read of owner A's plan", async () => {
    const { data, error } = await ownerB.db
      .from('action_plans')
      .select('id, summary')
      .eq('id', planId)

    expect(error).toBeNull()
    expect(data).toEqual([])

    // ...and the row really exists, so the denial is the policy and not absence.
    const { data: rows, error: readError } = await admin
      .from('action_plans')
      .select('id')
      .eq('id', planId)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(1)
  })

  it("denies owner B a read of owner A's problems, actions and citations", async () => {
    // These three tables are one and two joins removed from company_id, so each
    // policy walks the parent chain on its own — three separate EXISTS clauses,
    // three separate ways to get it wrong.
    const [problems, actions, citations] = await Promise.all([
      ownerB.db.from('plan_problems').select('id').eq('plan_id', planId),
      ownerB.db.from('plan_actions').select('problem_id').eq('problem_id', problemId),
      ownerB.db.from('plan_problem_submissions').select('submission_id').eq('problem_id', problemId),
    ])

    expect(problems.error).toBeNull()
    expect(problems.data).toEqual([])
    expect(actions.error).toBeNull()
    expect(actions.data).toEqual([])
    expect(citations.error).toBeNull()
    expect(citations.data).toEqual([])

    const [adminProblems, adminActions, adminCitations] = await Promise.all([
      admin.from('plan_problems').select('id').eq('plan_id', planId),
      admin.from('plan_actions').select('problem_id').eq('problem_id', problemId),
      admin.from('plan_problem_submissions').select('submission_id').eq('problem_id', problemId),
    ])
    expect(adminProblems.data).toHaveLength(1)
    expect(adminActions.data).toHaveLength(1)
    expect(adminCitations.data).toHaveLength(1)
  })

  it('scopes an unfiltered select to the calling owner only', async () => {
    // The mass-disclosure shape: PostgREST allows a select with no filter, so a
    // policy keyed on the wrong column would hand over every tenant's plans in
    // one request.
    const { data, error } = await ownerB.db.from('action_plans').select('id, company_id')

    expect(error).toBeNull()
    expect(data!.map((row) => row.id)).not.toContain(planId)
    expect(data!.every((row) => row.company_id === ownerB.companyId)).toBe(true)
  })

  it("denies owner B a read of owner A's generation ledger", async () => {
    const { error: seedError } = await ownerA.db
      .from('plan_generations')
      .insert({ company_id: ownerA.companyId })
    expect(seedError).toBeNull()

    const { data, error } = await ownerB.db
      .from('plan_generations')
      .select('id, company_id')
      .eq('company_id', ownerA.companyId)

    expect(error).toBeNull()
    expect(data).toEqual([])

    // ...and the row really exists, so the denial is the policy and not absence.
    const { data: rows, error: readError } = await admin
      .from('plan_generations')
      .select('id')
      .eq('company_id', ownerA.companyId)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(1)
  })

  it("denies owner B an INSERT into the ledger naming owner A's company", async () => {
    // The count the cap trigger runs is per company_id, so an unpinned insert
    // would let one owner burn a stranger's daily budget — a denial of service
    // against their Generate button. plan_generations_insert_own is the pin.
    const { error } = await ownerB.db
      .from('plan_generations')
      .insert({ company_id: ownerA.companyId })

    expect(error?.code).toBe('42501')

    const { data: rows, error: readError } = await admin
      .from('plan_generations')
      .select('id')
      .eq('company_id', ownerA.companyId)
    expect(readError).toBeNull()
    // Only the row owner A seeded above.
    expect(rows).toHaveLength(1)
  })
})

/**
 * FR-009 lets an owner delete a submission. plan_problem_submissions cascades
 * from it on purpose: citations vanish rather than dangle, and a saved problem
 * can legitimately end up with none. "Grounded" is a statement about generation
 * time, not forever — and the saved-plan page (Phase 5) has to render that
 * state rather than error on it, which is what makes this worth pinning.
 */
describe('citation cascade on submission delete', () => {
  it('removes the citation and leaves the problem and plan intact', async () => {
    const [doomed] = await seedSubmissions(ownerA.companyId, [
      `Zgłoszenie do skasowania ${randomUUID()}`,
    ])

    const { data: planId, error } = await ownerA.db.rpc('save_action_plan', {
      p_summary: 'Plan cytujący zgłoszenie, które zaraz zniknie.',
      p_problems: [
        {
          title: 'Problem z kasowanym cytatem',
          rationale: 'Cytuje dwa zgłoszenia, jedno zostanie usunięte.',
          submissionIds: [doomed, subA[0]],
          actions: ['Krok, który przeżyje usunięcie zgłoszenia.'],
        },
      ],
    })
    expect(error).toBeNull()

    const { data: problems } = await admin
      .from('plan_problems')
      .select('id')
      .eq('plan_id', planId)
    const problemId = problems![0].id

    const { data: before } = await admin
      .from('plan_problem_submissions')
      .select('submission_id')
      .eq('problem_id', problemId)
    expect(before).toHaveLength(2)

    const { error: deleteError } = await ownerA.db
      .from('submissions')
      .delete()
      .eq('id', doomed)
    expect(deleteError).toBeNull()

    const { data: after, error: afterError } = await admin
      .from('plan_problem_submissions')
      .select('submission_id')
      .eq('problem_id', problemId)
    expect(afterError).toBeNull()
    expect(after).toHaveLength(1)
    expect(after![0].submission_id).toBe(subA[0])

    // The problem, its action and the plan header all survive — the delete
    // cascades one table, not up the chain.
    const { data: problemStillThere } = await admin
      .from('plan_problems')
      .select('id')
      .eq('id', problemId)
    expect(problemStillThere).toHaveLength(1)

    const { data: actionsStillThere } = await admin
      .from('plan_actions')
      .select('id')
      .eq('problem_id', problemId)
    expect(actionsStillThere).toHaveLength(1)
  })
})

/**
 * The spend bound. A paid model call sits behind the Generate button, and
 * because review-then-save makes generating and saving separate acts, the cap
 * has to bind the GENERATION — capping saves would leave generate-and-discard,
 * the exact loop a stuck retry falls into, completely unbounded.
 *
 * Its own throwaway tenant: ten ledger rows on a shared company would poison
 * the ledger expectations of the isolation block above.
 */
describe('daily plan generation cap', () => {
  let capOwner: Owner

  beforeAll(async () => {
    capOwner = await createOwner('cap')

    // Seed the cap MINUS ONE past RLS in a single statement, so the boundary
    // itself is still crossed by a real authenticated insert below rather than
    // assumed. A batch is safe regardless of how the trigger's count sees rows
    // from its own statement: starting from zero it reaches at most
    // PLAN_GENERATION_CAP - 2, which is under the threshold either way.
    const { error } = await admin.from('plan_generations').insert(
      Array.from({ length: PLAN_GENERATION_CAP - 1 }, () => ({
        company_id: capOwner.companyId,
      }))
    )
    if (error) throw error
  })

  afterAll(async () => {
    await capOwner.db.auth.signOut()
    await admin.auth.admin.deleteUser(capOwner.userId)
  })

  it('accepts the last generation under the cap and refuses the one past it', async () => {
    const under = await capOwner.db
      .from('plan_generations')
      .insert({ company_id: capOwner.companyId })
    // The cap must not fire early: an owner iterating on their plan nine times
    // in a day is a user, not a runaway.
    expect(under.error).toBeNull()

    const over = await capOwner.db
      .from('plan_generations')
      .insert({ company_id: capOwner.companyId })

    // PostgREST's PTxyz -> HTTP xyz mapping is the one link in this chain that
    // cannot be verified by reading this repo, so log what actually arrived
    // before asserting on it. If the mapping ever changes, the run output names
    // the replacement instead of only saying "expected PT429".
    console.info('[plan cap] rejection as received by supabase-js:', JSON.stringify(over.error))
    expect(over.error?.code).toBe('PT429')

    const { count, error: countError } = await admin
      .from('plan_generations')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', capOwner.companyId)
    expect(countError).toBeNull()
    expect(count).toBe(PLAN_GENERATION_CAP)
  })

  it('refuses a ledger INSERT that supplies its own created_at', async () => {
    // grant insert (company_id) — naming created_at touches a column outside
    // the grant, so Postgres refuses before RLS is consulted. This is not
    // hygiene: a table-wide insert grant would let an owner backdate every row
    // out of the trigger's 24-hour window and defeat the cap entirely, which is
    // exactly what the test above would then stop proving.
    const { error } = await capOwner.db.from('plan_generations').insert({
      company_id: capOwner.companyId,
      created_at: '2000-01-01T00:00:00Z',
    })

    expect(error?.code).toBe('42501')
  })

  it('refuses a ledger INSERT that supplies its own id', async () => {
    const { error } = await capOwner.db.from('plan_generations').insert({
      id: randomUUID(),
      company_id: capOwner.companyId,
    })

    expect(error?.code).toBe('42501')
  })
})

/**
 * What can a stranger holding nothing but the public anon key do to the plan
 * surface? The intended answer is "nothing at all" — the public form (S-06) is
 * the product's only unauthenticated path and it does not touch plans.
 *
 * Assert on the ERROR, never on an empty array. An empty array is also what a
 * GRANTED select with no matching policy returns, and the two mean opposite
 * things: one is "anon cannot read this table", the other is "anon can read
 * this table and today no policy lets a row through" — one migration away from
 * disclosure.
 */
describe('plan surface is closed to anon', () => {
  const anon = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  it('denies anon a read of all five tables', async () => {
    for (const table of [...PLAN_TABLES, 'plan_generations']) {
      const { error } = await anon.from(table).select('*')
      expect(error?.code, `SELECT on ${table}`).toBe('42501')
    }
  })

  it('denies anon an INSERT into the generation ledger', async () => {
    const { error } = await anon
      .from('plan_generations')
      .insert({ company_id: ownerA.companyId })

    expect(error?.code).toBe('42501')
  })

  it('denies anon execution of save_action_plan at the GRANT layer', async () => {
    // This case is why the suite exists. As first written, the migration ended
    // with `revoke all on function ... from public` and a grant to
    // `authenticated`, and its comment claimed the RPC was owner-only. It was
    // not: Supabase's default privileges grant EXECUTE on new functions
    // DIRECTLY to anon, and revoking from the PUBLIC pseudo-role leaves a direct
    // grant to a named role untouched. Anon reached the function BODY and was
    // stopped only by its null-company check — the second layer doing the
    // first's job. 20260814134807_harden_plan_rpc_grants.sql closes it.
    //
    // Hence the message assertion below, which is the whole point: both
    // refusals report 42501, so the code alone cannot tell "anon may not call
    // this function" from "anon called it and it raised". Only the text can.
    const { error } = await anon.rpc('save_action_plan', {
      p_summary: 'Plan od nikogo.',
      p_problems: [
        {
          title: 'Od nikogo',
          rationale: 'Od nikogo.',
          submissionIds: [subA[0]],
          actions: ['Od nikogo.'],
        },
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

    // ...and the assertion that would still mean something if the layers ever
    // swapped: no plan landed on owner A's company.
    const { data: rows, error: readError } = await admin
      .from('action_plans')
      .select('id')
      .eq('company_id', ownerA.companyId)
      .eq('summary', 'Plan od nikogo.')
    expect(readError).toBeNull()
    expect(rows).toHaveLength(0)
  })
})
