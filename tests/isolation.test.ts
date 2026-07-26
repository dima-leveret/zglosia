import { randomUUID } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
