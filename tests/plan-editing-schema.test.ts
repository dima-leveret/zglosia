import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ACTION_CONTENT_MAX,
  PLAN_PROBLEMS_MAX,
  PLAN_SUMMARY_MAX,
  PROBLEM_ACTIONS_MAX,
  PROBLEM_RATIONALE_MAX,
  PROBLEM_TITLE_MAX,
  PlanEditSchema,
  PlanOriginalSchema,
} from '@/lib/plan-schema'

/**
 * Pure unit tests for the S-04 edit round trip — no network, no Supabase, no
 * token. Same reasoning src/lib/plan-schema.ts gives for staying pure: a
 * guarantee that can only be exercised by paying a model, or by provisioning a
 * database user, is a guarantee nobody re-runs.
 *
 * These pin FAILURE ORDERING, not safety. Nothing here can tell whether a uuid
 * names a problem of the caller's own plan — update_action_plan() answers that
 * inside the transaction, and tests/plan-editing.test.ts asserts it on SQLSTATE.
 * What this file pins is that a malformed body dies HERE, as one logged parse
 * failure, rather than at PostgREST as a raw 22P02 the Server Action would then
 * have to translate for the owner.
 */

/**
 * Drops one key, so a "field is missing" case reads as the omission it is.
 * Destructuring the key into a discarded binding would say the same thing to
 * the compiler and something else entirely to the linter.
 */
function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

/** A well-formed payload: one problem, one action, every id uuid-shaped. */
function validPlan() {
  return {
    summary: 'Klienci skarżą się na czas obsługi.',
    problems: [
      {
        id: randomUUID(),
        title: 'Długi czas oczekiwania',
        rationale: 'Dwa zgłoszenia wprost mówią o kolejce.',
        actions: [{ id: randomUUID(), content: 'Otwórz drugą kasę.' }],
      },
    ],
  }
}

describe('PlanEditSchema', () => {
  it('accepts a well-formed payload', () => {
    const result = PlanEditSchema.safeParse(validPlan())

    expect(result.success).toBe(true)
  })

  it('keeps every key update_action_plan reads out of the jsonb argument', () => {
    // The decisive case for the round trip: Zod STRIPS unknown keys, so a
    // schema that forgot `id` would parse successfully and hand the RPC a
    // payload whose problems name nothing — which the RPC reports as
    // "0 of 1 posted problems belong to this plan" (23514), a confusing way to
    // learn that the schema is wrong rather than the data.
    const payload = validPlan()
    const result = PlanEditSchema.safeParse(payload)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      summary: payload.summary,
      problems: [
        {
          id: payload.problems[0].id,
          title: payload.problems[0].title,
          rationale: payload.problems[0].rationale,
          actions: [
            {
              id: payload.problems[0].actions[0].id,
              content: payload.problems[0].actions[0].content,
            },
          ],
        },
      ],
    })
  })

  it('drops submissionIds rather than passing it through', () => {
    // Editing never touches plan_problem_submissions. A payload carrying
    // citations is a client that believes otherwise; the parse must not carry
    // that belief into the RPC's jsonb argument, where an unread key would sit
    // looking meaningful to the next reader of the migration.
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [{ ...payload.problems[0], submissionIds: [randomUUID()] }],
    })

    expect(result.success).toBe(true)
    expect(result.data!.problems[0]).not.toHaveProperty('submissionIds')
  })

  it('rejects a problem with no id', () => {
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [omit(payload.problems[0], 'id')],
    })

    expect(result.success).toBe(false)
  })

  it('rejects a problem whose id is not uuid-shaped', () => {
    // Without this the value reaches Postgres and comes back as 22P02 from the
    // `(e.value ->> 'id')::uuid` cast — an error the owner must never see.
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [{ ...payload.problems[0], id: 'not-a-uuid' }],
    })

    expect(result.success).toBe(false)
  })

  it('rejects an action with no id', () => {
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [
        { ...payload.problems[0], actions: [omit(payload.problems[0].actions[0], 'id')] },
      ],
    })

    expect(result.success).toBe(false)
  })

  it('rejects an action whose id is not uuid-shaped', () => {
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [
        {
          ...payload.problems[0],
          actions: [{ ...payload.problems[0].actions[0], id: '42' }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  it('rejects a whitespace-only title as blank, not as too short', () => {
    // trim must run BEFORE the min check, or "   " passes here and fails at the
    // plan_problems_title_bounds CHECK instead — the failure ordering this
    // module exists to avoid.
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [{ ...payload.problems[0], title: '   \n\t  ' }],
    })

    expect(result.success).toBe(false)
  })

  it('rejects a whitespace-only summary, rationale and action content', () => {
    const payload = validPlan()

    expect(PlanEditSchema.safeParse({ ...payload, summary: '  ' }).success).toBe(false)
    expect(
      PlanEditSchema.safeParse({
        ...payload,
        problems: [{ ...payload.problems[0], rationale: '  ' }],
      }).success
    ).toBe(false)
    expect(
      PlanEditSchema.safeParse({
        ...payload,
        problems: [
          {
            ...payload.problems[0],
            actions: [{ ...payload.problems[0].actions[0], content: '  ' }],
          },
        ],
      }).success
    ).toBe(false)
  })

  it(`accepts a summary at exactly ${PLAN_SUMMARY_MAX} characters and rejects one past it`, () => {
    // The cap mirrors action_plans_summary_bounds. Getting it wrong in either
    // direction is a real failure: too low and the owner cannot save wording the
    // database would accept, too high and the CHECK refuses after they pressed
    // Save.
    const payload = validPlan()

    expect(
      PlanEditSchema.safeParse({ ...payload, summary: 'a'.repeat(PLAN_SUMMARY_MAX) }).success
    ).toBe(true)
    expect(
      PlanEditSchema.safeParse({ ...payload, summary: 'a'.repeat(PLAN_SUMMARY_MAX + 1) }).success
    ).toBe(false)
  })

  it('rejects an over-long title, rationale and action content', () => {
    const payload = validPlan()

    expect(
      PlanEditSchema.safeParse({
        ...payload,
        problems: [{ ...payload.problems[0], title: 'a'.repeat(PROBLEM_TITLE_MAX + 1) }],
      }).success
    ).toBe(false)
    expect(
      PlanEditSchema.safeParse({
        ...payload,
        problems: [
          { ...payload.problems[0], rationale: 'a'.repeat(PROBLEM_RATIONALE_MAX + 1) },
        ],
      }).success
    ).toBe(false)
    expect(
      PlanEditSchema.safeParse({
        ...payload,
        problems: [
          {
            ...payload.problems[0],
            actions: [
              {
                ...payload.problems[0].actions[0],
                content: 'a'.repeat(ACTION_CONTENT_MAX + 1),
              },
            ],
          },
        ],
      }).success
    ).toBe(false)
  })

  it('rejects a plan with zero problems', () => {
    // The removal floor, at the first layer. An owner who removes their way to
    // an empty plan has deleted it by another name, and the editor disables the
    // last Remove button for exactly this reason — the RPC's 22023 is the
    // backstop, and this is the layer between them.
    const result = PlanEditSchema.safeParse({ ...validPlan(), problems: [] })

    expect(result.success).toBe(false)
  })

  it('rejects a problem with zero actions', () => {
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [{ ...payload.problems[0], actions: [] }],
    })

    expect(result.success).toBe(false)
  })

  it(`rejects more than ${PLAN_PROBLEMS_MAX} problems`, () => {
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: Array.from({ length: PLAN_PROBLEMS_MAX + 1 }, () => ({
        ...payload.problems[0],
        id: randomUUID(),
      })),
    })

    expect(result.success).toBe(false)
  })

  it(`rejects more than ${PROBLEM_ACTIONS_MAX} actions on one problem`, () => {
    const payload = validPlan()
    const result = PlanEditSchema.safeParse({
      ...payload,
      problems: [
        {
          ...payload.problems[0],
          actions: Array.from({ length: PROBLEM_ACTIONS_MAX + 1 }, () => ({
            id: randomUUID(),
            content: 'Wypełniacz.',
          })),
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  it('rejects a payload that is not an object at all', () => {
    // What a JSON.parse of a tampered hidden field can hand this schema.
    expect(PlanEditSchema.safeParse(null).success).toBe(false)
    expect(PlanEditSchema.safeParse('plan').success).toBe(false)
    expect(PlanEditSchema.safeParse([]).success).toBe(false)
  })
})

describe('PlanOriginalSchema', () => {
  const original = {
    summary: 'Podsumowanie, które wygenerował model.',
    problems: [
      {
        title: 'Długi czas oczekiwania',
        rationale: 'Tak to opisał model.',
        actions: ['Otwórz drugą kasę.', 'Wprowadź zamówienia mobilne.'],
      },
    ],
  }

  it('parses the shape update_action_plan writes', () => {
    // This object is jsonb_build_object()'s output in
    // 20260815160000_saved_plans_management.sql, key for key. If the migration's
    // shape and this schema ever drift, the original view goes blank — and the
    // roadmap's "zachowanie oryginału generacji" quietly stops being true.
    const result = PlanOriginalSchema.safeParse(original)

    expect(result.success).toBe(true)
    expect(result.data).toEqual(original)
  })

  it('accepts a problem whose actions array is empty', () => {
    // Nothing generated today can produce this — save_action_plan() enforces at
    // least one action. Rejecting it would mean a plan whose original cannot be
    // SHOWN, which is strictly worse than showing a problem with no steps under
    // it, so the permissiveness is deliberate.
    const result = PlanOriginalSchema.safeParse({
      ...original,
      problems: [{ ...original.problems[0], actions: [] }],
    })

    expect(result.success).toBe(true)
  })

  it('rejects a snapshot missing its summary or problems', () => {
    expect(PlanOriginalSchema.safeParse({ problems: original.problems }).success).toBe(false)
    expect(PlanOriginalSchema.safeParse({ summary: original.summary }).success).toBe(false)
  })

  it('rejects a problem missing title, rationale or actions', () => {
    for (const key of ['title', 'rationale', 'actions'] as const) {
      const result = PlanOriginalSchema.safeParse({
        ...original,
        problems: [omit(original.problems[0], key)],
      })

      expect(result.success, `problem missing ${key}`).toBe(false)
    }
  })

  it('rejects a snapshot that is not an object', () => {
    // The column CHECK is only `jsonb_typeof(...) = 'object'`, and the generated
    // types say no more than "some json" — so the render path parses rather than
    // casts, and this is the case that keeps it honest.
    expect(PlanOriginalSchema.safeParse(null).success).toBe(false)
    expect(PlanOriginalSchema.safeParse('{}').success).toBe(false)
    expect(PlanOriginalSchema.safeParse([]).success).toBe(false)
  })
})
