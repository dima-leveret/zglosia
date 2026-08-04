import { z } from 'zod'

/**
 * Validates the owner's email for the magic-link request. Trimmed + well-formed.
 * The reusable Zod pattern later forms inherit.
 */
export const LoginSchema = z.object({
  // Trim first, then validate — so surrounding whitespace doesn't fail a
  // otherwise-valid address.
  email: z
    .string()
    .trim()
    .pipe(z.email({ error: 'Enter a valid email address.' })),
})

/**
 * State returned by a form's Server Action and consumed by `useActionState`.
 * `errors` carries per-field validation messages; `message` carries a
 * success/confirmation or provider-error string.
 *
 * Generic over its field names so each form declares only the fields it can
 * actually produce errors for — otherwise every form's keys accumulate in one
 * shared type and the login form ends up advertising a `location` error it can
 * never return.
 */
export type FormState<TFields extends string = string> =
  | {
      errors?: Partial<Record<TFields, string[]>>
      message?: string
      /**
       * The submitted values, echoed back so a rejected form can re-fill
       * itself. Only forms that have no stored row to re-fill from need this:
       * React resets an uncontrolled form once its action completes and does
       * not distinguish a success from a validation failure, so without an
       * echo a rejected submission is simply erased. Populate it on failure
       * and leave it absent on success — the reset then clears the form, which
       * is what success should look like.
       */
      values?: Partial<Record<TFields, string>>
    }
  | undefined

/** Caps chosen as an S-03 prompt-token budget, not as a cosmetic limit. */
const SHORT_FIELD_MAX = 120
const DESCRIPTION_MAX = 2000

/**
 * Same budget, same reasoning: every submission is fed to the S-03 action-plan
 * prompt, and the prompt's ceiling is the number of submissions times this.
 *
 * Exported because the textarea sets `maxLength` from it — the browser-side cap
 * and the server-side cap must be the same number, and a literal in the JSX is
 * how they drift.
 *
 * Mirrored by the `submissions_content_bounds` CHECK constraint
 * (supabase/migrations/20260804183507_submission_content_bounds.sql). Zod is
 * not a boundary — a direct PostgREST call skips it entirely — so the database
 * enforces the same bound independently. Change both together.
 */
export const SUBMISSION_CONTENT_MAX = 2000

/**
 * A required, trimmed text field. Trim is registered before the length checks,
 * so a whitespace-only value fails `min(1)` rather than sneaking through.
 */
const requiredText = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, { error: `${label} is required.` })
    .max(max, { error: `${label} must be ${max} characters or fewer.` })

/**
 * The company profile as the owner submits it (FR-002). All four fields are
 * required *here*, at the form boundary — the database columns stay nullable
 * because `handle_new_user()` provisions every row blank at signup, so a NOT
 * NULL would break account creation.
 *
 * The field set is shaped as company context for the S-03 action-plan prompt:
 * industry and location change which improvements are even plausible, and
 * description carries whatever the owner considers relevant.
 */
export const CompanyProfileSchema = z.object({
  name: requiredText('Company name', SHORT_FIELD_MAX),
  industry: requiredText('Industry', SHORT_FIELD_MAX),
  description: requiredText('Description', DESCRIPTION_MAX),
  location: requiredText('Location', SHORT_FIELD_MAX),
})

export type CompanyProfileInput = z.infer<typeof CompanyProfileSchema>

/** The profile field names, in display order. */
export const COMPANY_PROFILE_FIELDS = [
  'name',
  'industry',
  'description',
  'location',
] as const

export type CompanyProfileField = (typeof COMPANY_PROFILE_FIELDS)[number]

/**
 * One manually added submission as the owner types it (FR-008).
 *
 * `source` is deliberately absent. It is not a field the owner can influence:
 * the action sets it to 'manual' server-side and the RLS `with check` pins it
 * there, so an owner's session cannot mint a row claiming to be a customer's
 * form submission. Accepting it here — even to ignore it — would put the
 * application in the business of deciding provenance, which is the database's
 * job in this design.
 */
export const SubmissionSchema = z.object({
  content: requiredText('Submission', SUBMISSION_CONTENT_MAX),
})

export type SubmissionInput = z.infer<typeof SubmissionSchema>

/**
 * The only field the add form can produce an error for. A union of one, so
 * `FormState<SubmissionField>` cannot silently accept a key the form never
 * renders.
 */
export type SubmissionField = 'content'

/** The nullable row shape the DAL returns for these fields. */
type CompanyProfileRow = Record<CompanyProfileField, string | null>

/**
 * Whether the owner has filled in every profile field. Single source of truth
 * for "incomplete", so the dashboard empty state and the profile page cannot
 * drift apart. Blank-but-present values count as incomplete — a row of spaces
 * is no more useful to the plan prompt than a NULL.
 */
export function isCompanyProfileComplete(
  company: CompanyProfileRow | null | undefined
): boolean {
  if (!company) {
    return false
  }

  return COMPANY_PROFILE_FIELDS.every(
    (field) => (company[field] ?? '').trim().length > 0
  )
}
