'use client'

import { useActionState } from 'react'

import type { CompanyProfileField } from '@/lib/validation'

import { updateCompanyProfile } from './actions'

type CompanyProfile = Record<CompanyProfileField, string | null>

const labelClass = 'text-sm font-medium text-zinc-700 dark:text-zinc-300'
const controlClass =
  'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50'

/**
 * `role="alert"` is not optional here. The inputs deliberately carry no HTML
 * `required` (see below), so these server messages are the only error channel
 * that exists — without an alert role and an aria-describedby link from the
 * control, a screen-reader user submits an invalid form and hears nothing at
 * all, then hears only the label on tabbing back.
 */
function FieldError({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages?.length) {
    return null
  }

  return (
    <p id={id} role="alert" className="text-sm text-red-600 dark:text-red-400">
      {messages[0]}
    </p>
  )
}

/**
 * The company profile editor. Values are pre-filled from the row so the form
 * doubles as the "view" surface — the owner sees what is stored and edits it
 * in place, rather than toggling between two modes.
 *
 * All four fields are required by CompanyProfileSchema on the server. The
 * inputs are deliberately NOT marked `required` in HTML: browser-native
 * validation would short-circuit submission and the owner would never see the
 * server's field-specific messages, which are the ones the tests pin.
 */
export function CompanyProfileForm({ company }: { company: CompanyProfile }) {
  const [state, action, pending] = useActionState(
    updateCompanyProfile,
    undefined
  )

  return (
    <form action={action} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="name" className={labelClass}>
          Company name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          maxLength={120}
          defaultValue={company.name ?? ''}
          placeholder="Kawiarnia Pod Lipą"
          aria-invalid={!!state?.errors?.name}
          aria-describedby={state?.errors?.name ? 'name-error' : undefined}
          className={`h-11 ${controlClass}`}
        />
        <FieldError id="name-error" messages={state?.errors?.name} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="industry" className={labelClass}>
          Industry
        </label>
        <input
          id="industry"
          name="industry"
          type="text"
          maxLength={120}
          defaultValue={company.industry ?? ''}
          placeholder="Gastronomia"
          aria-invalid={!!state?.errors?.industry}
          aria-describedby={
            state?.errors?.industry ? 'industry-error' : undefined
          }
          className={`h-11 ${controlClass}`}
        />
        <FieldError id="industry-error" messages={state?.errors?.industry} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="location" className={labelClass}>
          Location
        </label>
        <input
          id="location"
          name="location"
          type="text"
          maxLength={120}
          defaultValue={company.location ?? ''}
          placeholder="Wrocław"
          aria-invalid={!!state?.errors?.location}
          aria-describedby={
            state?.errors?.location ? 'location-error' : undefined
          }
          className={`h-11 ${controlClass}`}
        />
        <FieldError id="location-error" messages={state?.errors?.location} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="description" className={labelClass}>
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={5}
          maxLength={2000}
          defaultValue={company.description ?? ''}
          placeholder="What the business does, who it serves, anything that shapes the improvements you'd act on."
          aria-invalid={!!state?.errors?.description}
          // The hint stays in the description list either way; the error is
          // appended so it is read after it rather than replacing it.
          aria-describedby={
            state?.errors?.description
              ? 'description-hint description-error'
              : 'description-hint'
          }
          className={controlClass}
        />
        <p
          id="description-hint"
          className="text-xs text-zinc-500 dark:text-zinc-500"
        >
          This context is used when generating your action plan.
        </p>
        <FieldError
          id="description-error"
          messages={state?.errors?.description}
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
      >
        {pending ? 'Saving…' : 'Save profile'}
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
