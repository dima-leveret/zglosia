/**
 * How many rows one read hands to the surface above it.
 *
 * These two constants describe DAL reads and lived in dal.ts until S-04, which
 * is where they read most naturally. They had to move: dal.ts carries
 * `server-only`, plan-schema.ts imports SUBMISSION_LIST_LIMIT for the upper
 * bound on a cited index, and the plan editor imports plan-schema's string
 * bounds for its `maxLength` attributes — so one value import chained
 * next/headers into the browser bundle and failed the build outright. Splitting
 * the numbers out is what keeps plan-schema.ts pure, which is the property that
 * module's own header claims for itself.
 *
 * Nothing here imports anything. That is the point.
 */

/**
 * How many submissions one page render will show, and the largest list the
 * action-plan prompt can ever present.
 *
 * The list is capped rather than paginated: the owner's next action is
 * "generate a plan from all of these", not "page through them", so offset links
 * would be scaffolding for a workflow the product does not have.
 */
export const SUBMISSION_LIST_LIMIT = 100

/**
 * How many saved plans one page render will show (FR-013).
 *
 * Capped rather than paginated, for the same reason SUBMISSION_LIST_LIMIT
 * gives: the owner's next action on this list is "open one of these" or "delete
 * one of these", not "page through them". The cap is far lower than the
 * submissions one and still generous — generation is throttled at 10 per
 * company per day by enforce_plan_generation_rate(), and saving is a deliberate
 * second act after a review, so this list grows in ones, not in hundreds.
 */
export const ACTION_PLAN_LIST_LIMIT = 50
