# ZGŁOSIA

Turn a pile of customer feedback into a saved **action plan**.

A small-business owner collects submissions from customers — complaints, remarks,
suggestions — and quickly hits the same wall: the messages keep arriving, but pulling a
concrete "what should I actually fix" out of them takes time nobody has. Spreadsheets and
dashboards stop at statistics. ZGŁOSIA goes one step further: on demand, it summarises the
problems that keep recurring and turns them into an ordered plan of improvement steps, which
the owner can edit and save on the company account.

The full product scope, personas and requirements live in
[`context/foundation/prd.md`](context/foundation/prd.md).

## How it works

1. **The owner signs in** with a magic link — no password.
2. **They fill in the company profile** (name, industry, description, location); this context
   is fed to the model later and makes the plan more specific.
3. **They get a public submission link and a QR code.** The link carries an unguessable
   company id, so nobody can enumerate their way to another company's form.
4. **Customers submit feedback** at that link — no account, no login. The owner can also add
   submissions manually (each row records whether it came from the form or by hand).
5. **The owner presses "Generate".** An LLM reads the company's own submissions and returns a
   summary of recurring problems plus an action plan, where every problem cites the real
   submissions it came from.
6. **They review, edit and save the plan.** Saved plans stay on the account and can be
   revisited, edited or deleted; the first edit snapshots what the model originally produced.

Two hard guarantees run through all of it: **no company can ever see another company's
submissions or plans** (enforced by row-level security in Postgres, not just in application
code), and **every problem in a generated plan is grounded in submissions the company actually
has** — a plan citing anything else is rejected rather than saved thinner.

## Stack

| | |
| --- | --- |
| Framework | Next.js 16 (App Router, Server Actions), React 19 |
| Language | TypeScript, `strict` |
| Data / auth | Supabase — Postgres with row-level security, magic-link auth |
| AI | Vercel AI SDK + OpenRouter, structured output validated with Zod |
| Styling | Tailwind CSS v4 |
| Tests | Vitest — unit tests plus integration tests against real Postgres |
| Deploy | Vercel |

Rationale for these choices: [`context/foundation/tech-stack.md`](context/foundation/tech-stack.md).

> **This repo runs a modified Next.js 16** with breaking changes compared with the stock
> release. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js
> code — patterns from the public docs or from memory may be wrong here. Most visibly: request
> interception lives in `src/proxy.ts`, not in a `middleware.ts`.

## Getting started

Requires Node.js 20+, npm, and Docker (for the local Supabase stack).

```bash
npm install

# Start Postgres, Auth, Studio and a local mail catcher, then apply every migration
npx supabase start
npx supabase db reset

npm run dev
```

The app is at http://localhost:3000. Sign-in emails do not leave the machine in local
development — open the mail catcher at http://localhost:54324 and click the magic link there.
Supabase Studio is at http://localhost:54323.

### Environment variables

Create `.env.local` (it is gitignored — never commit it). `npx supabase start` prints the URL
and keys for the first three.

| Variable | Required | What it is |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase API URL (`http://127.0.0.1:54321` locally) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Anonymous key — the only key the browser ever sees |
| `SUPABASE_SERVICE_ROLE_KEY` | tests only | Bypasses RLS; used by the integration suites to provision test users. Never import it into application code. |
| `OPENROUTER_API_KEY` | yes | OpenRouter credentials for the plan-generation step |
| `ZGLOSIA_PLAN_MODEL` | yes | OpenRouter model id, e.g. `nvidia/nemotron-3-super-120b-a12b:free`. Swapping models is config, not a deploy. |
| `NEXT_PUBLIC_SITE_URL` | no | Origin used for magic-link redirects and QR codes. Falls back to `VERCEL_PROJECT_PRODUCTION_URL`, then `http://localhost:3000`. Set it explicitly in production. |

Any origin used for sign-in must also be in `additional_redirect_urls` in
[`supabase/config.toml`](supabase/config.toml).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3000 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (flat config) — run before pushing |
| `npm test` | Full Vitest suite, once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:remote` | Same as `npm test`, with the local-database guard overridden |

## Tests

Around 180 tests across nine files. They split into two kinds:

- **Pure unit tests** — validation rules, plan-schema bounds, prompt numbering and citation
  resolution, QR rendering, site-URL resolution. No network, no database; they run anywhere.
- **Integration tests against a real Postgres** — tenant isolation, table grants, the
  `save_action_plan` / `update_action_plan` functions, the anonymous submission path, and the
  rate caps. These are deliberately not mocked: row-level security lives in Postgres, so a
  mocked client would pass with every policy dropped.

The database-touching suites **refuse to run against a non-local host**
([`tests/support/require-local-db.ts`](tests/support/require-local-db.ts)) — they create and
delete real auth users with the service-role key, so pointing them at a hosted project would
be a data-loss event. Start a local Supabase before running the full suite:

```bash
npx supabase start && npx supabase db reset
npm test
```

Keep test credentials in `.env.test.local`; Vite's `loadEnv` gives it precedence over
`.env.local`, so it overrides without disturbing the dev setup.

Which risks these tests are meant to cover, and which are not covered yet, is written down in
[`context/foundation/test-plan.md`](context/foundation/test-plan.md).

## Project layout

```
src/
  app/
    login/                 magic-link sign-in
    auth/confirm/          magic-link callback
    dashboard/             owner surface (auth required)
      company/               profile + account deletion
      submissions/           list, add manually, delete
      plans/                 generate, review, save, list
        [planId]/            read, edit, delete one plan
      form-link/             public URL + QR code (qr/ serves the PNG)
    f/[companyId]/         public submission form (no login)
  lib/
    dal.ts                 the auth gate + every owner-scoped read
    supabase/              server and browser clients
    plan-prompt.ts         builds the numbered prompt sent to the model
    plan-schema.ts         plan bounds, Zod schemas, citation resolution
    validation.ts          form schemas shared by actions and components
  proxy.ts                 request interception (this fork's middleware)
supabase/migrations/       schema, RLS policies, grants, RPCs
tests/                     Vitest suites
context/                   the written foundation this app was built from
```

Import from `src/` with the `@/*` alias rather than deep relative paths.

## Conventions worth knowing before you change anything

- **The company scope always comes from the session** — never from `FormData`, a query param
  or a hidden input. RLS would reject a forged id anyway; the application must not be the layer
  that tries.
- **Server Actions are POSTs to their own route**, so `src/proxy.ts` does not guard them.
  `verifySession()` in `src/lib/dal.ts` is the real auth boundary, and every action calls it
  first.
- **Owner writes end in `.select('id')` and check the row count.** A write matching zero rows
  returns `{ data: null, error: null }`, so without it a policy-silenced no-op is
  indistinguishable from success and the owner is told it saved. (The anonymous form insert is
  the one deliberate exception — `anon` cannot read the row back; see the comment in
  `src/app/f/[companyId]/actions.ts`.)
- **Grants ship in the migration that creates the object**, with the narrowest verb and the
  narrowest column set. More lessons of this kind:
  [`context/foundation/lessons.md`](context/foundation/lessons.md).
- **A migration in the repo is not a migration in the database.** Vercel auto-deploys code on
  merge; migrations do not ride along. Apply them yourself.

## Documentation map

| File | What it holds |
| --- | --- |
| [`context/foundation/prd.md`](context/foundation/prd.md) | Product requirements — vision, personas, user stories, FR/NFR (in Polish) |
| [`context/foundation/roadmap.md`](context/foundation/roadmap.md) | Delivery slices S-01…S-06 and their status |
| [`context/foundation/tech-stack.md`](context/foundation/tech-stack.md) | Why this stack |
| [`context/foundation/test-plan.md`](context/foundation/test-plan.md) | Risk map, phased test rollout, quality gates |
| [`context/foundation/infrastructure.md`](context/foundation/infrastructure.md) | Deployment platform decision |
| [`context/foundation/lessons.md`](context/foundation/lessons.md) | Recurring pitfalls found while building this |
| `context/changes/<id>/` | Per-change brief, plan and reviews |
| `context/archive/` | Completed changes — immutable, do not edit |
