import {
  PLAN_PROBLEMS_MAX,
  PROBLEM_ACTIONS_MAX,
  PROBLEM_CITATIONS_MAX,
} from '@/lib/plan-schema'

/**
 * Builds the two messages the action-plan model is called with (S-03, FR-011).
 *
 * Pure and synchronous on purpose: the prompt is the part of this feature most
 * likely to be edited under pressure ("it keeps answering in English", "it
 * summarises instead of advising"), and a prompt that can only be inspected by
 * paying for a completion is a prompt nobody checks before shipping.
 */

/**
 * One submission as the prompt renders it.
 *
 * `id` is carried but never written into the prompt. It is here so that the ONE
 * array the caller passes is simultaneously the numbering the model sees and
 * the lookup table resolveCitations() resolves against — see the numbering
 * contract below. Splitting it into "the texts for the prompt" and "the ids for
 * the resolver" is how the two get reordered independently, and a reordering
 * bug here silently attributes real customer words to the wrong problem.
 */
export type PlanPromptSubmission = {
  id: string
  content: string
}

/** The company context fields, exactly as getCompany() returns them. */
export type PlanPromptCompany = {
  name: string | null
  industry: string | null
  description: string | null
  location: string | null
}

export type PlanPromptInput = {
  company: PlanPromptCompany | null
  submissions: readonly PlanPromptSubmission[]
}

export type PlanPrompt = {
  system: string
  prompt: string
}

/**
 * NUMBERING CONTRACT — the one invariant this module shares with
 * resolveCitations().
 *
 * Submission at array position i is presented to the model as number i + 1, and
 * resolveCitations() reads index n back as `submissionIds[n - 1]`. Both sides
 * derive from the same array in the same order, so the only way to break the
 * mapping is to pass a different array to each — which is why buildPlanPrompt()
 * takes whole rows rather than a list of strings.
 */
const promptIndex = (position: number) => position + 1

/**
 * The instruction message. English, because it is internal machinery like every
 * log line and error string in this codebase; the OUTPUT language is pinned
 * separately and explicitly.
 *
 * That pin is not boilerplate. Submissions are often three or four words long,
 * and on a thin, terse input a multilingual model will happily answer in
 * English — which would hand a Polish small-business owner a plan they cannot
 * use, from their own customers' words.
 */
function buildSystemMessage(): string {
  return [
    'You are an operations analyst for a small business. You are given the ' +
      "business's own customer submissions (complaints, remarks, suggestions) " +
      'and you turn them into a short action plan the owner can act on this week.',
    '',
    'OUTPUT LANGUAGE: Polish. Every string you produce — the summary, every ' +
      'problem title and rationale, every action — must be written in Polish, ' +
      'regardless of the language of the submissions or of these instructions.',
    '',
    'Rules:',
    '1. GROUNDING. Every problem you report must come from the submissions you ' +
      'were given. Cite the submissions it came from by their number, in ' +
      '`submissionIndexes`, using at least one and at most ' +
      `${PROBLEM_CITATIONS_MAX} of the most representative numbers. Never ` +
      'invent a complaint, a cause, or a detail that no cited submission ' +
      'supports. If the submissions do not support a problem, leave it out.',
    '2. RECURRENCE. Report themes that repeat across submissions, not a ' +
      'restatement of individual ones. Merge submissions that describe the ' +
      'same underlying problem into one entry.',
    `3. PRIORITY. Report at most ${PLAN_PROBLEMS_MAX} problems, ordered from ` +
      'most to least important. Weigh how often a problem recurs together with ' +
      'how urgent it is — a rare but serious problem can outrank a frequent ' +
      'trivial one. The order of the array is the priority order.',
    `4. ACTIONS. Give each problem at most ${PROBLEM_ACTIONS_MAX} concrete ` +
      'steps that address THAT problem. A step must be something the owner can ' +
      'actually do (change a process, buy something, retrain someone, adjust ' +
      'opening hours). Not "improve quality", not "monitor the situation".',
    '5. SUMMARY. Open with a short paragraph naming the recurring problems in ' +
      'priority order, so the owner knows what they are looking at before they ' +
      'read the details.',
  ].join('\n')
}

/**
 * The company context block. Included because industry and location change
 * which improvements are even plausible — "extend the terrace" is advice for a
 * café, not for a locksmith — which is the reason CompanyProfileSchema has
 * exactly these four fields (src/lib/validation.ts).
 *
 * The profile is optional at every level: rows are provisioned blank at signup
 * and the plans page prompts for completion without blocking. Blank fields are
 * omitted rather than rendered as "null", which reads to a model as a fact
 * about the business.
 */
function buildCompanyBlock(company: PlanPromptCompany | null): string[] {
  const fields: [string, string | null | undefined][] = [
    ['Name', company?.name],
    ['Industry', company?.industry],
    ['Location', company?.location],
    ['Description', company?.description],
  ]

  const filled = fields
    .filter(([, value]) => (value ?? '').trim().length > 0)
    .map(([label, value]) => `${label}: ${value!.trim()}`)

  if (filled.length === 0) {
    return [
      'THE BUSINESS: no profile on file. Keep the actions generic enough to ' +
        'apply to any small business.',
    ]
  }

  return ['THE BUSINESS:', ...filled]
}

/**
 * The submission list. Numbered from 1, one entry per line, content collapsed
 * onto that line.
 *
 * The collapse is deliberate: a submission containing its own blank lines and
 * "1." bullets would otherwise be indistinguishable from the list structure
 * around it, and a model that miscounts the list miscites every problem. The
 * caps in validation.ts (2000 chars) and dal.ts (100 rows) are what keep the
 * whole block inside a known ceiling.
 */
function buildSubmissionBlock(
  submissions: readonly PlanPromptSubmission[]
): string[] {
  return submissions.map(
    (submission, position) =>
      `${promptIndex(position)}. ${submission.content.replace(/\s+/g, ' ').trim()}`
  )
}

export function buildPlanPrompt({
  company,
  submissions,
}: PlanPromptInput): PlanPrompt {
  const prompt = [
    ...buildCompanyBlock(company),
    '',
    `CUSTOMER SUBMISSIONS (${submissions.length}), numbered — cite these numbers:`,
    ...buildSubmissionBlock(submissions),
    '',
    'Produce the action plan in Polish, grounded only in the submissions above.',
  ].join('\n')

  return { system: buildSystemMessage(), prompt }
}
