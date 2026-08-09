'use client'

import { useActionState, useState } from 'react'

import { SUBMISSION_CONTENT_MAX } from '@/lib/validation'

import { submitPublicSubmission } from './actions'
import { PUBLIC_SUBMISSION_SENT } from './messages'
import { HONEYPOT_FIELD, RENDERED_AT_FIELD } from './screening'

const controlClass =
  'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50'

const buttonClass =
  'flex h-11 items-center justify-center rounded-full bg-foreground px-5 font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]'

/**
 * The customer's form (US-02, FR-006) — the only surface in the product an
 * actual customer touches, and the only one written in Polish.
 *
 * Split in two on purpose. `useActionState` keeps its state for the life of the
 * component, so "send another" cannot clear a landed submission from inside the
 * component that owns that state. The outer component holds an attempt counter
 * and keys the inner one on it; bumping the counter remounts the fields, which
 * resets the action state to `undefined` — one mechanism, no second copy of
 * "what does empty look like".
 */
export function PublicSubmissionForm({
  companyId,
  renderedAt,
}: {
  companyId: string
  renderedAt: number
}) {
  const [attempt, setAttempt] = useState(0)

  return (
    <PublicSubmissionFields
      key={attempt}
      companyId={companyId}
      renderedAt={renderedAt}
      onSendAnother={() => setAttempt((current) => current + 1)}
    />
  )
}

function PublicSubmissionFields({
  companyId,
  renderedAt,
  onSendAnother,
}: {
  companyId: string
  renderedAt: number
  onSendAnother: () => void
}) {
  // Bound rather than read from a form field, so the action's parameter comes
  // from the route segment and not from this component's own field contract.
  // That is hygiene, not a boundary — React serializes bound arguments into the
  // action payload either way, and nothing here relies on the id staying
  // secret. It cannot: the anon policy deliberately does not constrain
  // company_id, because the link IS the capability. Retargeting the payload at
  // another company id is exactly as powerful as opening that company's link,
  // which anyone holding it may do.
  const [state, action, pending] = useActionState(
    submitPublicSubmission.bind(null, companyId),
    undefined
  )

  const error = state?.errors?.content?.[0]

  // Compared against the shared constant rather than an inlined literal, which
  // is why messages.ts exists — see its file comment.
  if (state?.message === PUBLIC_SUBMISSION_SENT) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-base text-black dark:text-zinc-50">
          {state.message}
        </p>
        {/* The confirmation REPLACES the form rather than clearing it. Somebody
            with no account and no receipt has nothing else to go on, and an
            emptied textarea reads the same as a submission that never left. */}
        <button type="button" onClick={onSendAnother} className={buttonClass}>
          Wyślij kolejne zgłoszenie
        </button>
      </div>
    )
  }

  return (
    <form action={action} className="flex w-full flex-col gap-3">
      {/* Honeypot. Positioned off-screen rather than `type="hidden"`: a bot
          skips hidden inputs by definition, which is the one thing that would
          defeat this. Hidden from assistive technology too, so a screen-reader
          user is never asked to fill in a field that would silently discard
          their submission. */}
      <input
        type="text"
        name={HONEYPOT_FIELD}
        defaultValue=""
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        className="absolute left-[-9999px] h-px w-px opacity-0"
      />

      {/* Server-stamped at render, so the elapsed-time check compares two
          server clocks and has no browser skew to defend against. Forgeable —
          it is unsigned — and knowingly so: the database cap is what bounds
          abuse. */}
      <input
        type="hidden"
        name={RENDERED_AT_FIELD}
        value={String(renderedAt)}
        readOnly
      />

      <div className="flex flex-col gap-2">
        <label
          htmlFor="content"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Twoje zgłoszenie
        </label>
        {/* No HTML `required`, and `role="alert"` + `aria-describedby` on the
            error — the two rules submission-form.tsx documents. Native
            validation would short-circuit the submit, and the customer would
            never see the server's own message. */}
        <textarea
          id="content"
          name="content"
          rows={6}
          maxLength={SUBMISSION_CONTENT_MAX}
          defaultValue={state?.values?.content ?? ''}
          placeholder="Napisz, co możemy poprawić — uwaga, skarga albo sugestia."
          aria-invalid={!!error}
          aria-describedby={
            error ? 'content-hint content-error' : 'content-hint'
          }
          className={controlClass}
        />
        <p id="content-hint" className="text-xs text-zinc-500 dark:text-zinc-500">
          Zgłoszenie jest anonimowe. Maksymalnie {SUBMISSION_CONTENT_MAX} znaków.
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

      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? 'Wysyłanie…' : 'Wyślij zgłoszenie'}
      </button>

      {/* Everything that is not the sent confirmation: the generic failure and
          the throttled message. The success branch returned above. */}
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
