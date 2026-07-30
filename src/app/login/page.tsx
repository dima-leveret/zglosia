import { LoginForm } from './login-form'

/** Flags /auth/confirm sets when it cannot complete a magic link. */
const CONFIRM_ERRORS: Record<string, string> = {
  invalid_link:
    'That sign-in link is invalid or has already been used. Request a new one below.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const error = (await searchParams).error
  const errorMessage = typeof error === 'string' ? CONFIRM_ERRORS[error] : undefined

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Sign in
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Enter your email and we&apos;ll send you a magic link.
          </p>
        </div>
        {errorMessage ? (
          <p
            role="alert"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {errorMessage}
          </p>
        ) : null}
        <LoginForm />
      </div>
    </main>
  )
}
