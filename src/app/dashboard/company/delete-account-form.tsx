'use client'

import { useActionState, useState } from 'react'

import { accountDeletionPhrase } from '@/lib/validation'

import { deleteAccount } from './actions'

/**
 * The destructive control, deliberately separate from the profile form so a
 * stray Enter key in an edit field can never reach it.
 *
 * Type-to-confirm rather than a plain dialog: this erases the account, the
 * company, and — once S-02/S-03 land — every submission and saved plan, with
 * no undo, no history table, and no export path in the MVP.
 */
export function DeleteAccountForm({ companyName }: { companyName: string | null }) {
  const phrase = accountDeletionPhrase(companyName)
  const [typed, setTyped] = useState('')
  const [state, action, pending] = useActionState(deleteAccount, undefined)

  // The gate is re-checked server-side; this only keeps the button honest.
  const confirmed = typed.trim() === phrase

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-red-300 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950/30">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-red-900 dark:text-red-200">
          Delete account
        </h2>
        <p className="text-sm text-red-800 dark:text-red-300">
          This permanently deletes your account and your company data. It cannot
          be undone, and there is no way to export your data first.
        </p>
      </div>

      <form action={action} className="flex flex-col gap-3">
        <label
          htmlFor="confirmation"
          className="text-sm text-red-800 dark:text-red-300"
        >
          Type <span className="font-mono font-semibold">{phrase}</span> to
          confirm.
        </label>
        <input
          id="confirmation"
          name="confirmation"
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          className="h-11 rounded-lg border border-red-300 bg-white px-3 text-black outline-none focus:border-red-500 dark:border-red-800 dark:bg-zinc-900 dark:text-zinc-50"
        />

        {state?.errors?.confirmation && (
          <p className="text-sm text-red-700 dark:text-red-400">
            {state.errors.confirmation[0]}
          </p>
        )}

        <button
          type="submit"
          disabled={!confirmed || pending}
          className="flex h-11 items-center justify-center rounded-full bg-red-600 px-5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Deleting…' : 'Delete my account permanently'}
        </button>

        {state?.message && (
          <p
            aria-live="polite"
            className="text-sm text-red-700 dark:text-red-400"
          >
            {state.message}
          </p>
        )}
      </form>
    </section>
  )
}
