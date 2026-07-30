/**
 * Guard for the suites that talk to a real database.
 *
 * Those suites create and delete real `auth.users` rows with the service-role
 * key and issue unfiltered UPDATEs that are safe only because RLS scopes them.
 * `vitest.config.ts` loads `.env.local` — the same file `npm run dev` uses — so
 * with that file pointed at the hosted project (its default state), a bare
 * `npm test` is a data-loss event against live data.
 *
 * Refuse unless the target is a local Supabase, or the operator opted in
 * explicitly. To keep test credentials separate from dev ones, put them in
 * `.env.test.local`: Vite's `loadEnv` gives `.env.test.local` precedence over
 * `.env.local`, so it overrides without touching the dev setup.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function requireLocalDb(url: string, suite: string) {
  if (LOCAL_HOSTS.has(new URL(url).hostname)) return
  if (process.env.ALLOW_REMOTE_TEST_DB === '1') return

  throw new Error(
    `${suite} refuses to run against ${new URL(url).host}: it creates and ` +
      'deletes real auth users with the service-role key. Point ' +
      'NEXT_PUBLIC_SUPABASE_URL at a local Supabase (`supabase start`, keys in ' +
      '.env.test.local), or set ALLOW_REMOTE_TEST_DB=1 to override deliberately.'
  )
}
