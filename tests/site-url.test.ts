import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  PUBLIC_FORM_PATH_PREFIX,
  buildPublicFormUrl,
  resolveSiteUrl,
} from '@/lib/site-url'

/**
 * The origin the app hands out — in magic-link emails and, since S-05, encoded
 * into printed QR codes. Deliberately a pure-function suite: no database, no
 * `requireLocalDb`, so it runs anywhere.
 *
 * `resolveSiteUrl()` is tested rather than the memoized `SITE_URL` constant
 * because the constant is evaluated at import; only the function can be
 * exercised against a varied environment.
 */
describe('resolveSiteUrl', () => {
  const KEYS = ['NEXT_PUBLIC_SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    // vitest.config.ts loads .env.local into process.env, so these are very
    // likely already set. Save, clear, and restore rather than assuming a clean
    // environment — otherwise the fallback cases silently test nothing.
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
  })

  it('prefers NEXT_PUBLIC_SITE_URL over everything else', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://zglosia.example'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'ignored.vercel.app'

    expect(resolveSiteUrl()).toBe('https://zglosia.example')
  })

  it('falls back to the Vercel production domain, adding the scheme', () => {
    // The platform injects a bare host with no scheme.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'zglosia.vercel.app'

    expect(resolveSiteUrl()).toBe('https://zglosia.vercel.app')
  })

  it('falls back to localhost when neither is set', () => {
    expect(resolveSiteUrl()).toBe('http://localhost:3000')
  })

  it('treats an empty NEXT_PUBLIC_SITE_URL as unset', () => {
    // An env var declared but left blank is a common deploy slip; it must not
    // resolve to an origin-less "" and produce protocol-relative URLs.
    process.env.NEXT_PUBLIC_SITE_URL = ''
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'zglosia.vercel.app'

    expect(resolveSiteUrl()).toBe('https://zglosia.vercel.app')
  })

  it('strips a trailing slash so callers can concatenate a rooted path', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://zglosia.example/'

    expect(resolveSiteUrl()).toBe('https://zglosia.example')
  })

  it('strips repeated trailing slashes', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://zglosia.example///'

    expect(resolveSiteUrl()).toBe('https://zglosia.example')
  })
})

describe('buildPublicFormUrl', () => {
  // The real shape: a v4 uuid, as `companies.id` holds it.
  const companyId = '3f2a7c58-9b41-4d6e-8a17-5c0e2b9d4f31'

  it('builds an absolute URL under the public form prefix', () => {
    const url = buildPublicFormUrl(companyId)

    // Asserted against the resolved origin rather than a hardcoded host, so the
    // test does not depend on which env var answered.
    expect(url).toBe(`${resolveSiteUrl()}${PUBLIC_FORM_PATH_PREFIX}/${companyId}`)
  })

  it('produces a parseable URL whose path carries the company id', () => {
    const { pathname } = new URL(buildPublicFormUrl(companyId))

    expect(pathname).toBe(`${PUBLIC_FORM_PATH_PREFIX}/${companyId}`)
  })

  it('never emits a doubled slash outside the scheme', () => {
    // The failure mode a trailing-slash origin would cause, asserted at the
    // level that actually matters: what gets encoded into the QR code. The
    // `[^:]` guard lets the scheme's own `://` through and nothing else.
    expect(buildPublicFormUrl(companyId)).not.toMatch(/[^:]\/\//)
  })

  it('gives two companies two different URLs', () => {
    const other = '8c1d0e44-2f73-4a90-b6e5-1d83c7f0a2b6'

    expect(buildPublicFormUrl(companyId)).not.toBe(buildPublicFormUrl(other))
  })
})
