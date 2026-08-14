/**
 * Outcome strings shared between the plan actions and the components that
 * react to them.
 *
 * They live here rather than in actions.ts for the reason
 * dashboard/submissions/messages.ts records: that module carries 'use server',
 * and every export from a server-action module must be an async function, so a
 * plain string constant cannot go there.
 *
 * English, like every other outcome string in the app. The Polish in this
 * feature is the MODEL's output — the plan itself — and the boundary between
 * the two runs exactly here: chrome and failures in English, generated content
 * in Polish.
 */

/**
 * The empty state, not an error. PRD acceptance for US-01 requires that with no
 * submissions the action is "niedostępna lub pokazuje stan pusty z
 * wyjaśnieniem, a nie pusty/błędny plan" — so this explains rather than blames.
 */
export const PLAN_NO_SUBMISSIONS =
  'There are no submissions to analyse yet. Collect a few and come back.'

/**
 * Deliberately one message for several causes: a transport failure, a model
 * that ignored the output schema, a model whose every problem cited a
 * submission that does not exist. The owner's next move is the same in all
 * three — press the button again — and the distinctions are logged rather than
 * surfaced.
 */
export const PLAN_GENERATION_FAILED =
  'Could not generate the action plan. Please try again.'

/**
 * Separate from the generic failure because the owner's next move IS different:
 * a timeout is worth retrying immediately, and saying so beats a silent 60
 * seconds followed by a shrug.
 */
export const PLAN_GENERATION_TIMED_OUT =
  'Generating the action plan took too long and was stopped. Please try again.'

/**
 * Raised by enforce_plan_generation_rate() at 10 attempts per company per day.
 * The cap binds GENERATION, not saving — see the migration — so an owner who
 * generates and discards ten times sees this too. That is the intent: the model
 * call is what costs money.
 */
export const PLAN_GENERATION_THROTTLED =
  'You have reached the daily limit for generating action plans. Please try again tomorrow.'

export const PLAN_SAVED = 'Action plan saved.'

/**
 * Generic on purpose, exactly like SUBMISSION_DELETE_FAILED. The RPC's own
 * error — including the one that names how many citations failed to resolve —
 * is logged and never shown: it would tell a tampered client precisely which
 * of its forged ids the database rejected.
 */
export const PLAN_SAVE_FAILED =
  'Could not save the action plan. Please try again.'

export const PLAN_DISCARDED = 'Action plan discarded. Nothing was saved.'
