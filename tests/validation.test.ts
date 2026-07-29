import { describe, expect, it } from 'vitest'

import {
  CompanyProfileSchema,
  isCompanyProfileComplete,
} from '../src/lib/validation'

/**
 * Pure unit tests — no network, no Supabase. These pin the contract the profile
 * form depends on: "all four required" is enforced here, at the form boundary,
 * because the database columns are deliberately nullable (rows are provisioned
 * blank at signup).
 */

const valid = {
  name: 'Kawiarnia Pod Lipą',
  industry: 'Gastronomia',
  description: 'Mała kawiarnia z wypiekami własnymi.',
  location: 'Wrocław',
}

/** Field names paired with the label their error message should carry. */
const fields = [
  ['name', 'Company name'],
  ['industry', 'Industry'],
  ['description', 'Description'],
  ['location', 'Location'],
] as const

describe('CompanyProfileSchema', () => {
  it('accepts a fully filled profile', () => {
    const result = CompanyProfileSchema.safeParse(valid)

    expect(result.success).toBe(true)
    expect(result.data).toEqual(valid)
  })

  it.each(fields)('rejects a missing %s', (field) => {
    const rest = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== field)
    )
    const result = CompanyProfileSchema.safeParse(rest)

    expect(result.success).toBe(false)
    expect(result.error!.flatten().fieldErrors[field]).toBeDefined()
  })

  it.each(fields)('rejects an empty %s', (field) => {
    const result = CompanyProfileSchema.safeParse({ ...valid, [field]: '' })

    expect(result.success).toBe(false)
    expect(result.error!.flatten().fieldErrors[field]).toBeDefined()
  })

  it.each(fields)('rejects a whitespace-only %s', (field) => {
    // The decisive case: trim must run BEFORE the min check, or "   " passes.
    const result = CompanyProfileSchema.safeParse({ ...valid, [field]: '    ' })

    expect(result.success).toBe(false)
    expect(result.error!.flatten().fieldErrors[field]).toBeDefined()
  })

  it.each(fields)('names the field in its %s error message', (field, label) => {
    const result = CompanyProfileSchema.safeParse({ ...valid, [field]: '' })

    expect(result.error!.flatten().fieldErrors[field]![0]).toContain(label)
  })

  it('trims surrounding whitespace on every field', () => {
    const result = CompanyProfileSchema.safeParse({
      name: '  Kawiarnia  ',
      industry: '  Gastronomia  ',
      description: '  Opis  ',
      location: '  Wrocław  ',
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      name: 'Kawiarnia',
      industry: 'Gastronomia',
      description: 'Opis',
      location: 'Wrocław',
    })
  })

  it('accepts short fields at exactly the 120-character cap', () => {
    const result = CompanyProfileSchema.safeParse({
      ...valid,
      name: 'a'.repeat(120),
    })

    expect(result.success).toBe(true)
  })

  it('rejects short fields past the 120-character cap', () => {
    const result = CompanyProfileSchema.safeParse({
      ...valid,
      name: 'a'.repeat(121),
    })

    expect(result.success).toBe(false)
    expect(result.error!.flatten().fieldErrors.name).toBeDefined()
  })

  it('accepts a description at exactly the 2000-character cap', () => {
    const result = CompanyProfileSchema.safeParse({
      ...valid,
      description: 'a'.repeat(2000),
    })

    expect(result.success).toBe(true)
  })

  it('rejects a description past the 2000-character cap', () => {
    // The cap is an S-03 prompt-token budget, so over-long input is a real
    // failure rather than a cosmetic one.
    const result = CompanyProfileSchema.safeParse({
      ...valid,
      description: 'a'.repeat(2001),
    })

    expect(result.success).toBe(false)
    expect(result.error!.flatten().fieldErrors.description).toBeDefined()
  })

  it('measures the cap after trimming, not before', () => {
    const result = CompanyProfileSchema.safeParse({
      ...valid,
      name: `  ${'a'.repeat(120)}  `,
    })

    expect(result.success).toBe(true)
  })
})

describe('isCompanyProfileComplete', () => {
  it('is false for a null company', () => {
    expect(isCompanyProfileComplete(null)).toBe(false)
  })

  it('is false for a freshly provisioned (all-NULL) row', () => {
    expect(
      isCompanyProfileComplete({
        name: null,
        industry: null,
        description: null,
        location: null,
      })
    ).toBe(false)
  })

  it.each(fields)('is false when only %s is missing', (field) => {
    expect(isCompanyProfileComplete({ ...valid, [field]: null })).toBe(false)
  })

  it.each(fields)('is false when %s is whitespace-only', (field) => {
    expect(isCompanyProfileComplete({ ...valid, [field]: '   ' })).toBe(false)
  })

  it('is true when all four fields are filled', () => {
    expect(isCompanyProfileComplete(valid)).toBe(true)
  })
})
