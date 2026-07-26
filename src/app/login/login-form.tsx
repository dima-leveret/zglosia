'use client'

import { useActionState } from 'react'

import { sendMagicLink } from './actions'

export function LoginForm() {
  const [state, action, pending] = useActionState(sendMagicLink, undefined)

  return (
    <form action={action} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="email"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
        {state?.errors?.email && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {state.errors.email[0]}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
      >
        {pending ? 'Sending…' : 'Send magic link'}
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
