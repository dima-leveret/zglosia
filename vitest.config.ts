import { fileURLToPath } from 'node:url'

import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * The isolation suite talks to a real Supabase instance — RLS can only be
 * proven against Postgres, not a mock — so the Supabase keys have to reach
 * process.env. Vitest does not read `.env.local` on its own; `loadEnv` with an
 * empty prefix pulls in every var (not just VITE_-prefixed ones) from
 * `.env`/`.env.local`/`.env.<mode>` and hands them to the test env.
 *
 * `.env.local` is also what `npm run dev` reads, so it normally points at the
 * hosted project. Keep test credentials in `.env.test.local` instead — loadEnv
 * gives `.env.<mode>.local` precedence over `.env.local`, and the DB-touching
 * suites refuse to run against a non-local host anyway (tests/support/
 * require-local-db.ts).
 */
export default defineConfig(({ mode }) => ({
  // Vite does not read tsconfig `paths`, so without this the tests would have
  // to reach into src/ with deep relative imports — which AGENTS.md forbids.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: loadEnv(mode, process.cwd(), ''),
    // Each test provisions real auth users over the network; the default 5s
    // budget is not enough for signup + sign-in round trips.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}))
