import { randomUUID } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireLocalDb } from './support/require-local-db'

/**
 * Phase 1 gate for S-01: proves the company_profile migration actually landed
 * on the target database.
 *
 * These assertions are behavioural rather than introspective. The plan
 * originally specified a psql script reading information_schema, but psql is
 * not installed here and SUPABASE_DB_URL is set nowhere — and PostgREST only
 * exposes the `public` schema, so information_schema is unreachable through
 * supabase-js anyway. Behaviour is the better evidence regardless: an
 * authenticated UPDATE that actually succeeds proves the grant more directly
 * than reading role_table_grants does.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing Supabase env. tests/schema.test.ts needs NEXT_PUBLIC_SUPABASE_URL, ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (loaded from .env.local).'
  )
}

requireLocalDb(url, 'tests/schema.test.ts')

/** Service-role client: bypasses RLS. Test-only. */
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let userId: string
let companyId: string
/** Anon-key client carrying the owner's session, so RLS and grants both apply. */
let ownerDb: SupabaseClient

beforeAll(async () => {
  const email = `schema-${randomUUID()}@example.com`
  const password = randomUUID()

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) throw createError
  if (!created.user) throw new Error('createUser returned no user')
  userId = created.user.id

  ownerDb = createClient(url!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInError } = await ownerDb.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  // Read the trigger-provisioned row through the service-role client so setup
  // does not depend on the policies these tests are adjacent to.
  const { data: company, error: companyError } = await admin
    .from('companies')
    .select('id')
    .eq('owner_id', userId)
    .single()
  if (companyError) throw companyError
  companyId = company.id
})

afterAll(async () => {
  // companies.owner_id is ON DELETE CASCADE, so removing the user removes the
  // company row with it.
  if (ownerDb) await ownerDb.auth.signOut()
  if (userId) await admin.auth.admin.deleteUser(userId)
})

describe('company_profile migration', () => {
  it('exposes the three new profile columns', async () => {
    // Selecting a column that does not exist is an error from PostgREST, so a
    // clean read is itself the existence assertion.
    const { data, error } = await admin
      .from('companies')
      .select('id, name, industry, description, location, created_at, updated_at')
      .eq('id', companyId)
      .single()

    expect(error).toBeNull()
    expect(data).not.toBeNull()
  })

  it('leaves the profile fields NULL on a freshly provisioned row', async () => {
    const { data, error } = await admin
      .from('companies')
      .select('name, industry, description, location')
      .eq('id', companyId)
      .single()

    expect(error).toBeNull()
    // Nullable is load-bearing: handle_new_user() inserts owner_id only, so a
    // NOT NULL on any of these would break signup outright.
    expect(data).toMatchObject({
      name: null,
      industry: null,
      description: null,
      location: null,
    })
  })

  it('advances updated_at on UPDATE via the new trigger', async () => {
    const { data: before, error: beforeError } = await admin
      .from('companies')
      .select('created_at, updated_at')
      .eq('id', companyId)
      .single()
    expect(beforeError).toBeNull()

    const { error: updateError } = await admin
      .from('companies')
      .update({ industry: 'trigger-probe' })
      .eq('id', companyId)
    expect(updateError).toBeNull()

    const { data: after, error: afterError } = await admin
      .from('companies')
      .select('updated_at')
      .eq('id', companyId)
      .single()
    expect(afterError).toBeNull()

    // Without the BEFORE UPDATE trigger this is equal, not greater — that was
    // the F-01 gap this migration closes.
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime()
    )
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.created_at).getTime()
    )
  })

  it('lets an authenticated owner UPDATE their own row (proves the grant)', async () => {
    // The whole point of the explicit GRANT: without UPDATE on the table, this
    // fails with a permission error before RLS is ever consulted.
    const { error } = await ownerDb
      .from('companies')
      .update({
        name: 'Grant Probe Co',
        industry: 'testing',
        description: 'Verifies the authenticated role may write.',
        location: 'Warsaw',
      })
      .eq('owner_id', userId)

    expect(error).toBeNull()

    const { data, error: readError } = await ownerDb
      .from('companies')
      .select('name, industry, description, location')
      .single()

    expect(readError).toBeNull()
    expect(data).toMatchObject({
      name: 'Grant Probe Co',
      industry: 'testing',
      description: 'Verifies the authenticated role may write.',
      location: 'Warsaw',
    })
  })
})

/**
 * Phase 1 gate for S-02.
 *
 * The four negative assertions here are the automated compensating control for
 * the revoke-then-grant block in 20260804171802_submission_intake.sql. The
 * linked project auto-exposes new tables, so without the revoke `create table`
 * would have already granted ALL to anon and authenticated and the migration's
 * narrow grants would add nothing — while still reading correctly in the repo.
 * Every one of these would then pass for the wrong reason, or fail loudly.
 * Verifying the privilege surface by eye in Studio is how that same class of
 * gap survived twice already.
 */
describe('submission_intake migration', () => {
  it('lets an authenticated owner INSERT a manual submission and read it back', async () => {
    // The positive control. Without it, every denial below would also pass on
    // a table nobody can write to at all.
    const { data: inserted, error: insertError } = await ownerDb
      .from('submissions')
      .insert({ company_id: companyId, content: 'Coffee was cold.', source: 'manual' })
      .select('id, content, source')

    expect(insertError).toBeNull()
    expect(inserted).toHaveLength(1)
    expect(inserted![0]).toMatchObject({ content: 'Coffee was cold.', source: 'manual' })

    const { data: read, error: readError } = await ownerDb
      .from('submissions')
      .select('id, company_id, content, source, created_at')
      .eq('id', inserted![0].id)
      .single()

    expect(readError).toBeNull()
    expect(read).toMatchObject({
      company_id: companyId,
      content: 'Coffee was cold.',
      source: 'manual',
    })
    expect(read!.created_at).toBeTruthy()
  })

  it('rejects a source outside the enum', async () => {
    const { error } = await ownerDb
      .from('submissions')
      .insert({ company_id: companyId, content: 'Bogus source.', source: 'imported' })
      .select('id')

    // The enum is what makes `source` a typed union downstream rather than a
    // bare string; a check constraint would not survive type generation.
    expect(error).not.toBeNull()
    expect(error!.code).toBe('22P02')
  })

  it('refuses an INSERT that supplies its own id (proves the column-scoped grant)', async () => {
    // grant insert (company_id, content, source) — naming `id` touches a column
    // outside the grant, so Postgres refuses before RLS is consulted. A
    // table-wide insert grant would let an owner pick their own primary key.
    const { error } = await ownerDb
      .from('submissions')
      .insert({
        id: randomUUID(),
        company_id: companyId,
        content: 'Self-chosen id.',
        source: 'manual',
      })
      .select('id')

    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('refuses an INSERT that supplies its own created_at (same grant)', async () => {
    const { error } = await ownerDb
      .from('submissions')
      .insert({
        company_id: companyId,
        content: 'Backdated.',
        source: 'manual',
        created_at: '2000-01-01T00:00:00Z',
      })
      .select('id')

    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('refuses any UPDATE (FR-010 is parked: no update grant, no update policy)', async () => {
    // Editing a customer's own words is the thing the PRD says not to do, so
    // the privilege does not exist at any layer. This test is what keeps a
    // future "just add update" migration honest.
    const { error } = await ownerDb
      .from('submissions')
      .update({ content: 'Rewritten by the owner.' })
      .eq('company_id', companyId)

    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('grants the anon role nothing at all (S-06 opens that surface, not this slice)', async () => {
    // A bare anon-key client with no session — exactly what a public form
    // request looks like today. Both verbs must be refused by the grant, not
    // merely filtered to zero rows by RLS.
    const anonDb = createClient(url!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { error: selectError } = await anonDb.from('submissions').select('id')
    expect(selectError).not.toBeNull()
    expect(selectError!.code).toBe('42501')

    const { error: insertError } = await anonDb
      .from('submissions')
      .insert({ company_id: companyId, content: 'From nobody.', source: 'form' })
      .select('id')
    expect(insertError).not.toBeNull()
    expect(insertError!.code).toBe('42501')
  })
})
