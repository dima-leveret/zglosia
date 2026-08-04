import { randomUUID } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireLocalDb } from './support/require-local-db'

/**
 * The executable guard on ZGŁOSIA's core security promise (PRD FR-001, NFR
 * "dane jednej firmy są nieosiągalne dla innej"): owner B must never be able to
 * read owner A's company row.
 *
 * This runs against a real Supabase instance on purpose. RLS lives in Postgres,
 * so a mocked client would assert nothing — it would happily "pass" with the
 * policies dropped. Downstream slices (S-01..S-06) inherit this isolation
 * contract, so a regression here silently reopens the leak for every table
 * added later.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing Supabase env. tests/isolation.test.ts needs NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (loaded from .env.local).'
  )
}

requireLocalDb(url, 'tests/isolation.test.ts')

/** Service-role client: bypasses RLS. Test-only — never an owner-facing read. */
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type Owner = {
  userId: string
  companyId: string
  /** Anon-key client carrying this owner's session, so RLS applies. */
  db: SupabaseClient
}

/**
 * Provisions a confirmed auth user and returns a client authenticated as them.
 * The company row is not created here on purpose — the `on_auth_user_created`
 * trigger is what provisions it, and that it did so is part of what we assert.
 */
async function createOwner(label: string): Promise<Owner> {
  const email = `rls-${label}-${randomUUID()}@example.com`
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

  // Read the trigger-provisioned row through the service-role client so this
  // setup step does not depend on the very RLS policy under test.
  const { data: company, error: companyError } = await admin
    .from('companies')
    .select('id')
    .eq('owner_id', created.user.id)
    .single()
  if (companyError) throw companyError

  return { userId: created.user.id, companyId: company.id, db }
}

let ownerA: Owner
let ownerB: Owner

beforeAll(async () => {
  ;[ownerA, ownerB] = await Promise.all([createOwner('a'), createOwner('b')])
})

afterAll(async () => {
  // companies.owner_id is ON DELETE CASCADE, so removing the users removes
  // their company rows too.
  await Promise.all(
    [ownerA, ownerB].filter(Boolean).map(async (owner) => {
      await owner.db.auth.signOut()
      await admin.auth.admin.deleteUser(owner.userId)
    })
  )
})

describe('per-company tenant isolation', () => {
  it('auto-provisions exactly one company per owner, visible to that owner', async () => {
    const { data, error } = await ownerA.db.from('companies').select('id, owner_id')

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({
      id: ownerA.companyId,
      owner_id: ownerA.userId,
    })
  })

  it('scopes an unfiltered select to the calling owner only', async () => {
    const { data, error } = await ownerB.db.from('companies').select('id, owner_id')

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({
      id: ownerB.companyId,
      owner_id: ownerB.userId,
    })
    // The decisive part: A's row exists but is absent from B's result set.
    expect(data!.map((row) => row.id)).not.toContain(ownerA.companyId)
  })

  it('denies owner B a targeted read of owner A\'s company row', async () => {
    const { data, error } = await ownerB.db
      .from('companies')
      .select('id, owner_id')
      .eq('id', ownerA.companyId)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('denies the symmetric read (owner A targeting owner B)', async () => {
    const { data, error } = await ownerA.db
      .from('companies')
      .select('id, owner_id')
      .eq('id', ownerB.companyId)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('confirms both rows really exist, so the denials above are RLS and not absence', async () => {
    const { data, error } = await admin
      .from('companies')
      .select('id')
      .in('id', [ownerA.companyId, ownerB.companyId])

    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })

  it('resolves current_company_id() to the caller\'s own company', async () => {
    const [a, b] = await Promise.all([
      ownerA.db.rpc('current_company_id'),
      ownerB.db.rpc('current_company_id'),
    ])

    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect(a.data).toBe(ownerA.companyId)
    expect(b.data).toBe(ownerB.companyId)
    expect(a.data).not.toBe(b.data)
  })
})

/**
 * S-01 extends the guarantee from reads to WRITES. The company profile is the
 * first owner-facing mutation in the product, so until this suite existed the
 * update and delete policies had never been exercised by a test.
 *
 * The load-bearing detail: a cross-tenant UPDATE matches zero rows and
 * PostgREST reports SUCCESS with an empty result — the denial is silent.
 * Asserting on `error` alone would therefore pass even with the policies
 * dropped. Every attempt below is followed by re-reading owner A's row through
 * the service-role client and proving it is unchanged; that re-read, not the
 * error check, is what actually demonstrates isolation.
 *
 * DELETE is the exception: migration 20260730104500 revokes it from
 * `authenticated` outright (review finding F3), so those attempts fail loudly
 * at the grant layer with 42501 — for owner B and owner A alike.
 */
describe('per-company write isolation', () => {
  const ownerAProfile = {
    name: 'Owner A Company',
    industry: 'Retail',
    description: "Belongs to owner A. Owner B must never be able to touch this.",
    location: 'Gdańsk',
  }

  beforeAll(async () => {
    // Seeded past RLS so the fixture does not depend on the policies under test.
    const { error } = await admin
      .from('companies')
      .update(ownerAProfile)
      .eq('id', ownerA.companyId)
    if (error) throw error
  })

  /** Owner A's row exactly as the database holds it, read past RLS. */
  async function readOwnerARow() {
    const { data, error } = await admin
      .from('companies')
      .select('id, owner_id, name, industry, description, location, updated_at')
      .eq('id', ownerA.companyId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  it("denies owner B an UPDATE of owner A's row, leaving it unchanged", async () => {
    const before = await readOwnerARow()
    expect(before).not.toBeNull()

    const { error } = await ownerB.db
      .from('companies')
      .update({ name: 'HIJACKED BY OWNER B' })
      .eq('id', ownerA.companyId)

    // Silent denial: success, zero rows affected.
    expect(error).toBeNull()

    const after = await readOwnerARow()
    // The decisive assertion — every column, including updated_at, is intact.
    expect(after).toEqual(before)
    expect(after!.name).toBe(ownerAProfile.name)
  })

  it("denies owner B an unfiltered UPDATE from reaching owner A's row", async () => {
    // An update with no id filter is scoped by RLS alone. It must rewrite only
    // owner B's own row, never every row the table holds.
    const before = await readOwnerARow()

    const { error } = await ownerB.db
      .from('companies')
      .update({ name: 'MASS UPDATE BY OWNER B' })
      .neq('id', '00000000-0000-0000-0000-000000000000')

    expect(error).toBeNull()

    const after = await readOwnerARow()
    expect(after).toEqual(before)

    // ...while owner B's own row did change, proving the write itself worked
    // and the isolation above is not a false negative from a no-op statement.
    const { data: ownerBRow, error: ownerBError } = await admin
      .from('companies')
      .select('name')
      .eq('id', ownerB.companyId)
      .single()
    expect(ownerBError).toBeNull()
    expect(ownerBRow!.name).toBe('MASS UPDATE BY OWNER B')
  })

  it("denies owner B a DELETE of owner A's row, leaving it present", async () => {
    const before = await readOwnerARow()

    // DELETE is revoked from `authenticated` entirely (migration
    // 20260730104500), so this is refused at the grant layer with 42501 rather
    // than silently matching zero rows.
    const { error } = await ownerB.db
      .from('companies')
      .delete()
      .eq('id', ownerA.companyId)

    expect(error?.code).toBe('42501')

    const { data: rows, error: existsError } = await admin
      .from('companies')
      .select('id')
      .eq('id', ownerA.companyId)
    expect(existsError).toBeNull()
    expect(rows).toHaveLength(1)

    const after = await readOwnerARow()
    expect(after).toEqual(before)
  })

  it('lets owner A update their own row and advances updated_at', async () => {
    // Positive control. Without it, all the denials above would still pass if
    // writes were broken outright (missing GRANT, wrong policy), and the suite
    // would report perfect isolation on a table nobody can write to.
    const before = await readOwnerARow()
    const description = `Updated by owner A at ${new Date().toISOString()}`

    const { error } = await ownerA.db
      .from('companies')
      .update({ description })
      .eq('owner_id', ownerA.userId)

    expect(error).toBeNull()

    const after = await readOwnerARow()
    expect(after!.description).toBe(description)
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime()
    )
  })

  it('denies owner B an INSERT that forges another owner_id', async () => {
    // The `with check` on companies_insert_own is the clause that stops one
    // owner from minting a tenant for someone else. It needs a free owner_id to
    // aim at: reusing owner A's would risk tripping the unique constraint
    // (23505) or the FK (23503) before the policy is ever consulted. So
    // provision a third user and clear the row its trigger created — now the
    // policy is the only thing that can refuse the insert.
    //
    // Since 20260730190000_narrow_company_write_grants.sql the INSERT privilege
    // is revoked outright, so 42501 now arrives from the grant layer before the
    // policy is consulted. Same code, earlier gate: this case proves owner B
    // cannot forge a tenant, not specifically that `with check` is what stops
    // them. The policy is retained as the second layer.
    const email = `rls-victim-${randomUUID()}@example.com`
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: randomUUID(),
      email_confirm: true,
    })
    expect(createError).toBeNull()
    const victimId = created!.user!.id

    try {
      await admin.from('companies').delete().eq('owner_id', victimId)

      const { error } = await ownerB.db
        .from('companies')
        .insert({ owner_id: victimId, name: 'FORGED BY OWNER B' })

      expect(error?.code).toBe('42501')

      const { data: rows, error: readError } = await admin
        .from('companies')
        .select('id')
        .eq('owner_id', victimId)
      expect(readError).toBeNull()
      expect(rows).toHaveLength(0)
    } finally {
      await admin.auth.admin.deleteUser(victimId)
    }
  })

  it('denies owner A a DELETE of their OWN row', async () => {
    // Owners must not be able to erase their own tenant: nothing re-provisions
    // it (the trigger fires only on auth.users insert), so a successful delete
    // would strand the account on the "no company" branch forever. Erasure is
    // the exclusive job of auth.admin.deleteUser + ON DELETE CASCADE.
    const { error } = await ownerA.db
      .from('companies')
      .delete()
      .eq('owner_id', ownerA.userId)

    expect(error?.code).toBe('42501')

    const { data: rows, error: readError } = await admin
      .from('companies')
      .select('id')
      .eq('id', ownerA.companyId)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(1)
  })
})

/**
 * S-02 carries the contract onto public.submissions — the FIRST table in the
 * product to key its RLS on public.current_company_id() rather than directly on
 * auth.uid(). The helper existed since F-01 but had no consumer, so until this
 * block ran, the predicate every downstream tenant table (S-03, S-04, S-06) is
 * built on had never been exercised against a real second tenant.
 *
 * Two ways this differs from the companies suite above, both load-bearing:
 *
 *   * DELETE is GRANTED here, unlike on companies where it is revoked outright.
 *     So a cross-tenant delete does not fail loudly with 42501 — it succeeds,
 *     matches zero rows, and reports nothing. The re-read through the
 *     service-role client is the only assertion that can tell that apart from a
 *     delete that actually destroyed the row.
 *   * The `source` column is pinned by the insert policy's `with check`, which
 *     nothing in the existing suites has an equivalent for.
 */
describe('submission isolation', () => {
  const OWNER_A_CONTENT = "Owner A's submission. Owner B must never see this."
  const OWNER_B_CONTENT = "Owner B's own submission."

  let ownerASubmissionId: string
  let ownerBSubmissionId: string

  beforeAll(async () => {
    // Seeded past RLS so the fixtures do not depend on the policies under test.
    const { data, error } = await admin
      .from('submissions')
      .insert([
        {
          company_id: ownerA.companyId,
          content: OWNER_A_CONTENT,
          source: 'manual',
        },
        {
          company_id: ownerB.companyId,
          content: OWNER_B_CONTENT,
          source: 'manual',
        },
      ])
      .select('id, company_id')
    if (error) throw error

    ownerASubmissionId = data!.find((r) => r.company_id === ownerA.companyId)!.id
    ownerBSubmissionId = data!.find((r) => r.company_id === ownerB.companyId)!.id
  })

  it('scopes an unfiltered select to the calling owner only', async () => {
    const { data, error } = await ownerB.db
      .from('submissions')
      .select('id, company_id, content')

    expect(error).toBeNull()
    expect(data!.map((row) => row.id)).toContain(ownerBSubmissionId)
    // The decisive part: A's row exists but is absent from B's result set.
    expect(data!.map((row) => row.id)).not.toContain(ownerASubmissionId)
    expect(data!.every((row) => row.company_id === ownerB.companyId)).toBe(true)
  })

  it("denies owner B a targeted read of owner A's submission", async () => {
    const { data, error } = await ownerB.db
      .from('submissions')
      .select('id, content')
      .eq('id', ownerASubmissionId)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('confirms both submissions really exist, so the denial is RLS and not absence', async () => {
    const { data, error } = await admin
      .from('submissions')
      .select('id')
      .in('id', [ownerASubmissionId, ownerBSubmissionId])

    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })

  it("denies owner B an INSERT naming owner A's company_id", async () => {
    const forged = 'FORGED INTO OWNER A BY OWNER B'

    const { error } = await ownerB.db
      .from('submissions')
      .insert({
        company_id: ownerA.companyId,
        content: forged,
        source: 'manual',
      })
      .select('id')

    // The insert policy's `with check` refuses the row outright — loudly, not
    // silently, because a rejected INSERT has no "zero rows matched" state.
    expect(error?.code).toBe('42501')

    const { data: rows, error: readError } = await admin
      .from('submissions')
      .select('id')
      .eq('company_id', ownerA.companyId)
      .eq('content', forged)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(0)
  })

  it("denies owner B a DELETE of owner A's submission, leaving it present", async () => {
    const { data, error } = await ownerB.db
      .from('submissions')
      .delete()
      .eq('id', ownerASubmissionId)
      .select('id')

    // Silent denial: DELETE is granted, so this SUCCEEDS and simply matches
    // nothing. An assertion on `error` alone would pass with the policies
    // dropped — which is exactly the failure mode this test exists to catch.
    expect(error).toBeNull()
    expect(data).toEqual([])

    // THIS is the assertion that means something.
    const { data: rows, error: readError } = await admin
      .from('submissions')
      .select('id, content')
      .eq('id', ownerASubmissionId)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows![0].content).toBe(OWNER_A_CONTENT)
  })

  it("denies owner B an unfiltered DELETE from reaching owner A's submissions", async () => {
    // The most dangerous statement shape on this table, and the reason it needs
    // its own case: DELETE is GRANTED to authenticated here, unlike on
    // companies where it is revoked and any attempt dies at 42501. So a delete
    // carrying no id filter is scoped by RLS and nothing else. If the policy
    // were wrong, this one statement would empty every tenant's submissions
    // rather than merely leak them — and it would do so silently.
    const { data, error } = await ownerB.db
      .from('submissions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')

    expect(error).toBeNull()
    // Only B's own rows came back; A's id is not among them.
    expect(data!.map((row) => row.id)).not.toContain(ownerASubmissionId)

    // The decisive assertion: A's row is untouched in the database.
    const { data: aRows, error: aError } = await admin
      .from('submissions')
      .select('id, content')
      .eq('id', ownerASubmissionId)
    expect(aError).toBeNull()
    expect(aRows).toHaveLength(1)
    expect(aRows![0].content).toBe(OWNER_A_CONTENT)

    // ...while owner B's own row DID go, proving the statement actually
    // executed and the isolation above is not a false negative from a delete
    // that matched nothing at all.
    const { data: bRows, error: bError } = await admin
      .from('submissions')
      .select('id')
      .eq('id', ownerBSubmissionId)
    expect(bError).toBeNull()
    expect(bRows).toHaveLength(0)
  })

  it('lets owner A insert, list, and delete their OWN submission', async () => {
    // Positive control. Without it every denial above would also pass on a
    // table nobody can write to, and the suite would report perfect isolation
    // on a broken feature.
    const content = `Owner A round-trip at ${new Date().toISOString()}`

    const { data: inserted, error: insertError } = await ownerA.db
      .from('submissions')
      .insert({
        company_id: ownerA.companyId,
        content,
        source: 'manual',
      })
      .select('id')

    expect(insertError).toBeNull()
    expect(inserted).toHaveLength(1)
    const id = inserted![0].id

    const { data: listed, error: listError } = await ownerA.db
      .from('submissions')
      .select('id, content')

    expect(listError).toBeNull()
    expect(listed!.map((row) => row.id)).toContain(id)

    const { data: deleted, error: deleteError } = await ownerA.db
      .from('submissions')
      .delete()
      .eq('id', id)
      .select('id')

    expect(deleteError).toBeNull()
    expect(deleted).toHaveLength(1)

    const { data: rows, error: readError } = await admin
      .from('submissions')
      .select('id')
      .eq('id', id)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(0)
  })
})

/**
 * FR-008's origin marking is only meaningful if it cannot be forged. An owner
 * who can mint rows claiming to be customer form submissions can manufacture
 * the appearance of customer demand and then generate an action plan from it —
 * so this is an integrity guarantee, not a labelling convenience.
 *
 * The pin lives in the insert policy's `with check`, which is why an anon-key
 * session cannot get around it by calling PostgREST directly instead of using
 * the form. Nothing in the existing suites covers this shape.
 */
describe('submission source integrity', () => {
  it("denies owner A an INSERT claiming source 'form' on their own company", async () => {
    const content = 'Owner A pretending to be a customer.'

    const { error } = await ownerA.db
      .from('submissions')
      .insert({
        company_id: ownerA.companyId,
        content,
        source: 'form',
      })
      .select('id')

    expect(error?.code).toBe('42501')

    const { data: rows, error: readError } = await admin
      .from('submissions')
      .select('id')
      .eq('company_id', ownerA.companyId)
      .eq('content', content)
    expect(readError).toBeNull()
    expect(rows).toHaveLength(0)
  })

  it("accepts the same INSERT with source 'manual'", async () => {
    // The companion assertion. Without it, a broken grant or a policy that
    // refuses everything would make the denial above pass for the wrong reason.
    const content = 'Owner A recording it honestly.'

    const { data, error } = await ownerA.db
      .from('submissions')
      .insert({
        company_id: ownerA.companyId,
        content,
        source: 'manual',
      })
      .select('id, source')

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].source).toBe('manual')
  })
})
