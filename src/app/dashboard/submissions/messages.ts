/**
 * Outcome strings shared between the submission actions and the components
 * that react to them.
 *
 * They live here rather than in actions.ts because that module carries
 * 'use server': every export from a server-action module must be an async
 * function, so a plain string constant cannot go there. The row needs to tell a
 * successful delete from a failed one to decide whether to move focus, and
 * comparing against an inlined literal in two files is how those two copies
 * drift apart.
 */
export const SUBMISSION_ADDED = 'Submission added.'
export const SUBMISSION_DELETED = 'Submission deleted.'

export const SUBMISSION_SAVE_FAILED =
  'Could not save the submission. Please try again.'

/**
 * Deliberately generic, and deliberately identical whether the row does not
 * exist or belongs to another company. Telling the owner "that submission isn't
 * yours" would confirm the id exists — a membership oracle over other tenants'
 * primary keys.
 */
export const SUBMISSION_DELETE_FAILED =
  'Could not delete that submission. Please try again.'
