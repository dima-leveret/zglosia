/**
 * The type-to-confirm gate for account deletion.
 *
 * This lives in its own module rather than in `validation.ts` for one reason:
 * `delete-account-form.tsx` is a client component and needs the phrase at
 * runtime. `validation.ts` imports zod and builds its schemas at module scope,
 * and a bundler cannot prove `z.object({...})` is side-effect-free — so a value
 * import from there drags zod into the client bundle to support three lines of
 * string handling.
 *
 * Both the form and the Server Action import from here, which keeps the
 * property that matters: the expected phrase is defined ONCE. If the two sides
 * ever computed it separately they could drift, and the gate would either block
 * a correct confirmation or — far worse — accept a wrong one.
 */

/** Used when there is no company name to type — a blank profile still needs a gate. */
export const ACCOUNT_DELETION_FALLBACK_PHRASE = 'DELETE'

/** The exact text an owner must type to confirm account deletion. */
export function accountDeletionPhrase(
  companyName: string | null | undefined
): string {
  const trimmed = (companyName ?? '').trim()
  return trimmed.length > 0 ? trimmed : ACCOUNT_DELETION_FALLBACK_PHRASE
}
