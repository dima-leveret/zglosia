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
 * State returned by the magic-link Server Action and consumed by
 * `useActionState`. `errors` carries per-field validation messages; `message`
 * carries a success/confirmation or provider-error string.
 */
export type FormState =
  | {
      errors?: {
        email?: string[]
      }
      message?: string
    }
  | undefined
