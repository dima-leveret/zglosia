'use client'

import { useActionState } from 'react'

import { SUBMISSION_CONTENT_MAX } from '@/lib/validation'

import { createSubmission } from './actions'

const controlClass =
  'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50'

/**
 * The add-a-submission form.
 *
 * Follows company-profile-form.tsx, including the two accessibility rules that
 * file documents: no HTML `required` (browser-native validation would
 * short-circuit submission and the owner would never see the server's
 * field-specific message), and `role="alert"` + `aria-describedby` so the error
 * is announced rather than silently rendered.
 *
 * Clearing on success and preserving on failure are ONE mechanism, not two.
 * React resets an uncontrolled form after its action completes and does not
 * distinguish a rejection from a success — so the naive build either clears on
 * both (and the owner loses up to 2000 typed characters to a trailing-space
 * rejection) or on neither. company-profile-form.tsx never exposes this because
 * every field re-fills from a stored row; this form has no row to re-fill from.
 * The action echoes the submitted text back in `state.values` on failure and
 * omits it on success, and `defaultValue` reads from that — so the same reset
 * restores the text in one case and clears the field in the other.
 */
export function SubmissionForm() {
  const [state, action, pending] = useActionState(createSubmission, undefined)

  const error = state?.errors?.content?.[0]

  return (
    <form action={action} className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="content"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Add a submission
        </label>
        <textarea
          id="content"
          name="content"
          rows={4}
          maxLength={SUBMISSION_CONTENT_MAX}
          defaultValue={state?.values?.content ?? ''}
          placeholder="What did the customer say? Paste or type their feedback in their own words."
          aria-invalid={!!error}
          aria-describedby={
            error ? 'content-hint content-error' : 'content-hint'
          }
          className={controlClass}
        />
        <p id="content-hint" className="text-xs text-zinc-500 dark:text-zinc-500">
          Record what the customer told you. Up to {SUBMISSION_CONTENT_MAX}{' '}
          characters.
        </p>
        {error && (
          <p
            id="content-error"
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
      >
        {pending ? 'Saving…' : 'Add submission'}
      </button>

      {state?.message && (
        <p
          aria-live="polite"
          className="text-sm text-zinc-600 dark:text-zinc-400"
        >
          {state.message}
        </p>
      )}
    </form>
  )
}
