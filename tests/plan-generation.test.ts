import { describe, expect, it } from 'vitest'

import { buildPlanPrompt } from '@/lib/plan-prompt'
import {
  PLAN_PROBLEMS_MAX,
  PROBLEM_TITLE_MAX,
  PlanOutputSchema,
  resolveCitations,
  type PlanOutput,
} from '@/lib/plan-schema'

/**
 * Phase 3 gate for S-03. Pure unit tests — no network, no Supabase, no model.
 *
 * These cover the half of the generation path that carries the
 * anti-hallucination NFR on the application side: the numbering the prompt
 * hands the model, and the resolution step that turns the model's indexes back
 * into real submission ids. Both are deterministic, so both can be pinned
 * without spending a token or depending on a model's mood — which matters,
 * because a guarantee that can only be exercised by paying for a completion is
 * a guarantee nobody re-runs.
 *
 * What is NOT here, deliberately: the model call itself. Stubbing generateText
 * would assert that the AI SDK calls the function we passed it, which is the
 * SDK's contract rather than ours. The live behaviour is covered by the manual
 * acceptance run in Phase 5.
 */

const company = {
  name: 'Kawiarnia Pod Lipą',
  industry: 'Gastronomia',
  description: 'Mała kawiarnia z wypiekami własnymi.',
  location: 'Wrocław',
}

const submissions = [
  { id: '11111111-1111-4111-8111-111111111111', content: 'Długo czekałem na kawę.' },
  { id: '22222222-2222-4222-8222-222222222222', content: 'Ciastka były czerstwe.' },
  { id: '33333333-3333-4333-8333-333333333333', content: 'Brak miejsca na wózek.' },
]

/** A well-formed model response over the three submissions above. */
const validOutput: PlanOutput = {
  summary: 'Najczęstsze problemy to czas oczekiwania i świeżość wypieków.',
  problems: [
    {
      title: 'Długi czas oczekiwania',
      rationale: 'Klienci zgłaszają, że czekają zbyt długo na zamówienie.',
      submissionIndexes: [1],
      actions: ['Dodaj drugi ekspres w godzinach szczytu.'],
    },
    {
      title: 'Świeżość wypieków',
      rationale: 'Wypieki bywają czerstwe pod koniec dnia.',
      submissionIndexes: [2],
      actions: ['Piecz mniejsze partie dwa razy dziennie.'],
    },
  ],
}

/** Deep-clones the fixture so a test can mutate its own copy in place. */
const outputFixture = (): PlanOutput => structuredClone(validOutput)

describe('buildPlanPrompt', () => {
  it('renders every submission exactly once, numbered from 1', () => {
    const { prompt } = buildPlanPrompt({ company, submissions })

    // The numbering contract resolveCitations() depends on: position i is
    // presented as i + 1, so index 1 must be the FIRST submission.
    expect(prompt).toContain('1. Długo czekałem na kawę.')
    expect(prompt).toContain('2. Ciastka były czerstwe.')
    expect(prompt).toContain('3. Brak miejsca na wózek.')

    for (const submission of submissions) {
      const occurrences = prompt.split(submission.content).length - 1
      expect(occurrences).toBe(1)
    }
  })

  it('never puts a submission id in the prompt', () => {
    // Ids are carried alongside the content purely so ONE array serves as both
    // the numbering and the lookup table. The model must never see them: an
    // echoed uuid is corrupted character by character and undetectably so.
    const { prompt, system } = buildPlanPrompt({ company, submissions })

    for (const submission of submissions) {
      expect(prompt).not.toContain(submission.id)
      expect(system).not.toContain(submission.id)
    }
  })

  it('collapses whitespace so a submission cannot forge list structure', () => {
    // A submission containing its own newlines and "1." bullets would otherwise
    // be indistinguishable from the numbered list around it, and a model that
    // miscounts the list miscites every problem.
    const { prompt } = buildPlanPrompt({
      company,
      submissions: [{ id: submissions[0].id, content: 'Pierwsza uwaga\n\n2. Druga uwaga' }],
    })

    expect(prompt).toContain('1. Pierwsza uwaga 2. Druga uwaga')
    expect(prompt).not.toContain('\n2. Druga uwaga')
  })

  it('pins the output language to Polish', () => {
    // Submissions are often three or four words long, and on thin input a
    // multilingual model defaults to English — which would hand a Polish owner
    // a plan they cannot use, built from their own customers' words.
    const { system } = buildPlanPrompt({ company, submissions })

    expect(system).toContain('OUTPUT LANGUAGE: Polish')
  })

  it('includes the company context fields', () => {
    const { prompt } = buildPlanPrompt({ company, submissions })

    expect(prompt).toContain('Kawiarnia Pod Lipą')
    expect(prompt).toContain('Gastronomia')
    expect(prompt).toContain('Wrocław')
    expect(prompt).toContain('Mała kawiarnia z wypiekami własnymi.')
  })

  it('omits blank profile fields rather than rendering them as null', () => {
    // Rows are provisioned blank at signup and the page prompts for completion
    // without blocking, so a half-filled profile is a normal state. "Industry:
    // null" reads to a model as a fact about the business.
    const { prompt } = buildPlanPrompt({
      company: { ...company, industry: null, location: '   ' },
      submissions,
    })

    expect(prompt).not.toContain('null')
    expect(prompt).not.toContain('Industry:')
    expect(prompt).not.toContain('Location:')
    expect(prompt).toContain('Name: Kawiarnia Pod Lipą')
  })

  it('says so explicitly when there is no profile at all', () => {
    const { prompt } = buildPlanPrompt({ company: null, submissions })

    expect(prompt).toContain('no profile on file')
  })
})

describe('resolveCitations', () => {
  const ids = submissions.map((submission) => submission.id)

  it('resolves valid indexes to the ids at those positions', () => {
    const { plan, droppedIndexes, droppedProblems } = resolveCitations(
      validOutput,
      ids
    )

    expect(droppedIndexes).toEqual([])
    expect(droppedProblems).toEqual([])
    expect(plan).not.toBeNull()
    expect(plan!.summary).toBe(validOutput.summary)
    expect(plan!.problems).toHaveLength(2)
    expect(plan!.problems[0].submissionIds).toEqual([ids[0]])
    expect(plan!.problems[1].submissionIds).toEqual([ids[1]])
  })

  it('emits the exact key names save_action_plan reads out of p_problems', () => {
    // title / rationale / submissionIds / actions. The save path hands this
    // array straight to the RPC, so a renamed key here is a plan that saves
    // with an empty citation list rather than a type error.
    const { plan } = resolveCitations(validOutput, ids)

    expect(Object.keys(plan!.problems[0]).sort()).toEqual([
      'actions',
      'rationale',
      'submissionIds',
      'title',
    ])
  })

  it('drops an out-of-range index and keeps the rest of the problem', () => {
    const output = outputFixture()
    output.problems[0].submissionIndexes = [1, 99]

    const { plan, droppedIndexes } = resolveCitations(output, ids)

    expect(droppedIndexes).toEqual([99])
    expect(plan!.problems[0].submissionIds).toEqual([ids[0]])
  })

  it('drops a problem whose every index is out of range', () => {
    const output = outputFixture()
    output.problems[0].submissionIndexes = [98, 99]

    const { plan, droppedIndexes, droppedProblems } = resolveCitations(
      output,
      ids
    )

    expect(droppedIndexes).toEqual([98, 99])
    expect(droppedProblems).toEqual(['Długi czas oczekiwania'])
    expect(plan!.problems).toHaveLength(1)
    expect(plan!.problems[0].title).toBe('Świeżość wypieków')
  })

  it('returns a null plan — not an empty one — when every problem is dropped', () => {
    // The decisive case. An empty plan is exactly the "pusty/błędny plan" the
    // PRD's US-01 acceptance criteria rule out, so total collapse has to be
    // distinguishable from a thin success. Null is what the action turns into a
    // failure message.
    const output = outputFixture()
    output.problems[0].submissionIndexes = [98]
    output.problems[1].submissionIndexes = [99]

    const { plan, droppedProblems } = resolveCitations(output, ids)

    expect(plan).toBeNull()
    expect(droppedProblems).toHaveLength(2)
  })

  it('deduplicates a submission cited twice by the same problem', () => {
    // Sloppy, not ungrounded: the review screen would otherwise render the same
    // quote twice under one heading, and save_action_plan() counts DISTINCT ids
    // for exactly the same reason.
    const output = outputFixture()
    output.problems[0].submissionIndexes = [1, 1, 2]

    const { plan, droppedIndexes } = resolveCitations(output, ids)

    expect(droppedIndexes).toEqual([])
    expect(plan!.problems[0].submissionIds).toEqual([ids[0], ids[1]])
  })

  it('treats index 0 as out of range', () => {
    // The list is 1-based. A 0 is what an absent or coerced number looks like,
    // and reading it as submissionIds[-1] would be undefined anyway — this
    // pins that it is REPORTED as a drop rather than silently ignored.
    const output = outputFixture()
    output.problems[0].submissionIndexes = [0]

    const { droppedIndexes, droppedProblems } = resolveCitations(output, ids)

    expect(droppedIndexes).toEqual([0])
    expect(droppedProblems).toEqual(['Długi czas oczekiwania'])
  })
})

describe('PlanOutputSchema', () => {
  it('accepts a well-formed plan', () => {
    expect(PlanOutputSchema.safeParse(validOutput).success).toBe(true)
  })

  it('rejects a problem that cites nothing', () => {
    // The schema's half of the grounding rule: an uncited problem never reaches
    // resolveCitations() at all.
    const output = outputFixture()
    output.problems[0].submissionIndexes = []

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })

  it('rejects a problem with no actions', () => {
    const output = outputFixture()
    output.problems[0].actions = []

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })

  it('rejects an empty problem list', () => {
    const output = outputFixture()
    output.problems = []

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })

  it('rejects more problems than the plan admits', () => {
    const output = outputFixture()
    output.problems = Array.from({ length: PLAN_PROBLEMS_MAX + 1 }, () =>
      structuredClone(validOutput.problems[0])
    )

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })

  it('rejects a title longer than the database CHECK allows', () => {
    // The bound is duplicated from plan_problems_title_bounds so an over-long
    // field fails at GENERATION time, where the owner can just press the button
    // again — instead of at save time, after they have accepted a plan they
    // then cannot keep.
    const output = outputFixture()
    output.problems[0].title = 'x'.repeat(PROBLEM_TITLE_MAX + 1)

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })

  it('rejects a whitespace-only title', () => {
    // Lines up with the migration's `~ '[^[:space:]]'` CHECK: trim runs before
    // the length checks, so "   " fails min(1) rather than passing maxLength
    // and then blowing up at save time.
    const output = outputFixture()
    output.problems[0].title = '    '

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })

  it('rejects a non-integer index', () => {
    const output = outputFixture()
    output.problems[0].submissionIndexes = [1.5]

    expect(PlanOutputSchema.safeParse(output).success).toBe(false)
  })
})
