# Vercel Integration & First Deployment Plan

## Context

ZGŁOSIA is a Next.js 16 + React 19 + TypeScript + Tailwind v4 app at MVP stage (minimal scaffold — one route, one Header component). The infrastructure research (`context/foundation/infrastructure.md`) selected Vercel as the deployment platform: zero-config Next.js 16 support, free tier covers all MVP traffic, instant rollback, and native GitHub auto-deploy-on-merge.

**Current state at plan creation (2026-06-22):**
- No Vercel config files (`vercel.json`, `.vercelignore`)
- No environment variables (no `.env*` files)
- No GitHub Actions workflows
- No `context/changes/deployment/` directory
- `.vercel/` is already in `.gitignore` ✓

**Goal:** Ship a verified production deployment with auto-deploy-on-merge, preview deployments per PR, and a documented operational runbook.

---

## Phase 1 — Vercel CLI Setup

> Manual gate: requires browser login and Vercel account.

- [ ] **1.1** Install Vercel CLI globally:
  ```bash
  npm i -g vercel
  ```
- [ ] **1.2** Verify installation:
  ```bash
  vercel --version
  ```
- [ ] **1.3** Authenticate with Vercel (opens browser):
  ```bash
  vercel login
  ```
  Select "Continue with GitHub" to link the same account used for the repo — this enables the GitHub integration later.

**Edge case:** If `vercel login` hangs or opens an unexpected browser, use `vercel login --github` explicitly, or copy the activation URL printed to terminal and open it manually.

---

## Phase 2 — Link Project to Vercel

- [ ] **2.1** From the project root, run the interactive setup:
  ```bash
  vercel link
  ```
  Answer the prompts:
  - "Set up and deploy?" → **No** (link only, don't deploy yet)
  - "Which scope?" → Select your personal account or team
  - "Link to existing project?" → **No** (create new)
  - "Project name?" → `zglosia` (or accept default)
  - "In which directory?" → `.` (current directory, accept default)

  This creates `.vercel/project.json` locally (gitignored — already in `.gitignore`).

- [ ] **2.2** Verify link succeeded:
  ```bash
  vercel project ls
  ```
  `zglosia` should appear in the list.

**Edge case:** If prompted about framework detection, Vercel should auto-detect Next.js. If it doesn't, manually confirm "Next.js" when asked.

---

## Phase 3 — GitHub Integration (Auto-Deploy-on-Merge)

> Manual gate: done in Vercel dashboard, not CLI.

- [ ] **3.1** Open Vercel Dashboard → Project `zglosia` → Settings → Git.
- [ ] **3.2** Under "Connected Git Repository", click "Connect" → select the GitHub repo `zglosia`.
- [ ] **3.3** Set Production Branch to `main`.
- [ ] **3.4** Confirm that "Deploy Hooks" is left at default — merge to `main` triggers production deploy automatically.

After this:
- Merges to `main` → auto-deploy to production
- Any PR → auto-creates a preview URL (Vercel comment on the PR)
- Fork PRs from external contributors do NOT get preview URLs (Vercel security default — this is correct)

**Edge case:** If the GitHub repo is private and Vercel can't find it, go to GitHub → Settings → Applications → Vercel → Repository access, and explicitly grant access to this repo.

---

## Phase 4 — Supabase Prerequisites

> Manual gate: requires a Supabase account and a new project created in the dashboard. Complete this phase before touching environment variables.

Supabase provides auth + Postgres for ZGŁOSIA (per `context/foundation/tech-stack.md`). Credentials from this phase feed directly into Phase 5.

### 4a — Create the Supabase project

- [ ] **4a.1** Sign in at https://supabase.com (create an account if needed).
- [ ] **4a.2** Click "New Project" and fill in:
  - Name: `zglosia`
  - Region: `eu-central-1` (Frankfurt — closest to Polish users; or choose another EU region to stay GDPR-compliant)
  - Database password: generate a strong password and save it in a password manager — **it cannot be retrieved later**

- [ ] **4a.3** Wait for provisioning (~1–2 minutes). Dashboard shows "Setting up your project" until ready.

**Edge case:** If provisioning takes longer than 5 minutes, refresh the dashboard. If still stuck, delete the project and create it again — first-time provisioning occasionally stalls.

### 4b — Collect connection credentials

- [ ] **4b.1** Go to Supabase Dashboard → Project → Settings → API.
- [ ] **4b.2** Copy the following and store them securely (in a local `.env.local` — never commit):

  | Variable | Where to find it | Client-safe? |
  |---|---|---|
  | `NEXT_PUBLIC_SUPABASE_URL` | Settings → API → Project URL | Yes |
  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Settings → API → Project API Keys → `anon public` | Yes (low-privilege) |
  | `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → Project API Keys → `service_role` | **No — server-only** |

  The `service_role` key bypasses Row Level Security entirely. It must never appear with a `NEXT_PUBLIC_` prefix or in any client bundle.

- [ ] **4b.3** Note the DB connection string for future migrations (Settings → Database → Connection string → URI):
  ```
  postgresql://postgres:[PASSWORD]@[host]:5432/postgres
  ```
  Store alongside the other credentials. Needed when running Supabase migrations or Prisma introspection locally.

**Edge case — `service_role` key accidentally committed to git:** Rotate it immediately via Supabase Dashboard → Settings → API → Regenerate service role key. The old key is invalidated instantly — all server-side API calls will fail until the new key is set in Vercel.

### 4c — Install Supabase client packages

- [ ] **4c.1** Install the Supabase JS client and the SSR helper for Next.js App Router:
  ```bash
  npm install @supabase/supabase-js @supabase/ssr
  ```

- [ ] **4c.2** Confirm both packages landed in `dependencies` (not `devDependencies`) in `package.json`.

- [ ] **4c.3** Create `.env.local` at the project root (gitignored):
  ```
  NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
  NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
  SUPABASE_SERVICE_ROLE_KEY=eyJ...
  ```

**Edge case — peer dependency conflict with React 19:** If `npm install` reports peer conflicts, run:
```bash
npm install @supabase/supabase-js @supabase/ssr --legacy-peer-deps
```
Check the Supabase changelog for the exact React 19 support date. As of 2026-06, `@supabase/supabase-js` v2.x is compatible.

### 4d — Create Supabase client helpers

- [ ] **4d.1** Create `src/lib/supabase/client.ts` for the browser client (respects Row Level Security):
  ```ts
  import { createBrowserClient } from '@supabase/ssr'

  export function createClient() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  }
  ```

- [ ] **4d.2** Create `src/lib/supabase/server.ts` for the server-only admin client (bypasses RLS):
  ```ts
  import { createClient } from '@supabase/supabase-js'

  export function createAdminClient() {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  ```
  Import `createAdminClient` only in Server Components, Route Handlers, or Server Actions — never in client components.

**Edge case:** Before writing middleware or auth helpers, read `node_modules/next/dist/docs/` for any middleware/cookie guidance specific to this Next.js 16 fork (per AGENTS.md). The `@supabase/ssr` cookie integration assumes standard Next.js middleware — verify no breaking changes apply.

---

## Phase 5 — Environment Variables in Vercel

With Supabase credentials in hand, configure them in Vercel so all deployment environments (production, preview, development) have access.

- [ ] **5.1** Add each variable in Vercel Dashboard → Project → Settings → Environment Variables:

  | Variable | Scope |
  |---|---|
  | `NEXT_PUBLIC_SUPABASE_URL` | Production + Preview + Development |
  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production + Preview + Development |
  | `SUPABASE_SERVICE_ROLE_KEY` | Production + Preview + Development |
  | `OPENROUTER_API_KEY` | _(add when OpenRouter is configured — Production + Preview)_ |

- [ ] **5.2** Sync env vars back to local `.env.local` to keep them in lockstep with Vercel:
  ```bash
  vercel env pull .env.local
  ```
  Run this whenever vars are updated in the dashboard.

**Edge case:** Never prefix `SUPABASE_SERVICE_ROLE_KEY` or `OPENROUTER_API_KEY` with `NEXT_PUBLIC_`. If done accidentally, the key is exposed in the browser bundle. Rotate the compromised key immediately and redeploy.

---

## Phase 6 — Pre-Deploy Local Verification

- [ ] **6.1** Run a production build locally to catch TypeScript and lint errors before they fail in Vercel CI:
  ```bash
  npm run build
  ```
  Must exit 0 with no errors.

- [ ] **6.2** Run linter:
  ```bash
  npm run lint
  ```
  Must exit 0.

- [ ] **6.3** (Recommended) Replicate the Vercel runtime locally:
  ```bash
  vercel dev
  ```
  Open http://localhost:3000 and confirm the app loads. Exit with `Ctrl+C`.

**Edge case:** If `vercel dev` fails with a port conflict, use `vercel dev --listen 3001`.

---

## Phase 7 — First Production Deploy

- [ ] **7.1** Deploy to production via CLI:
  ```bash
  vercel --prod
  ```
  Output includes the production URL (e.g. `https://zglosia.vercel.app`).

- [ ] **7.2** Record the result:
  ```
  Production URL: ___________________________
  Deploy date:    2026-06-22
  ```

**Alternative path:** If GitHub integration (Phase 3) is already complete, merging to `main` triggers the first production deploy automatically. Equivalent to 7.1 — pick one.

**Edge case — Build passes locally but fails on Vercel:**
1. Vercel Dashboard → Project → Deployments → failed deploy → Build Logs
2. **Node version mismatch:** Add to `package.json` if Vercel picks the wrong version:
   ```json
   "engines": { "node": "20.x" }
   ```
3. **Tailwind v4 PostCSS:** Check build log for `@tailwindcss/postcss` errors. Vercel installs `devDependencies` during build by default — this should work without extra config.
4. **Missing env vars:** If a build-time var is missing, the build fails with `undefined`. Verify all `NEXT_PUBLIC_*` vars are set in Vercel dashboard for the Production scope.

---

## Phase 8 — Post-Deploy Verification

- [ ] **8.1** Open the production URL in a browser. Confirm:
  - App loads (root page renders)
  - Header component is visible
  - No browser console errors

- [ ] **8.2** Check Vercel Dashboard:
  - Deployments list shows green "Ready" status
  - Build duration < 60s (expect ~15–30s for this scaffold)

- [ ] **8.3** Verify preview deploys work:
  - Create a test branch, push a trivial change, open a PR
  - Vercel bot should comment with a preview URL within ~1 minute

- [ ] **8.4** Verify Supabase connectivity (once a DB-touching route exists):
  - Hit a route that queries Supabase
  - Tail logs: `vercel logs --follow`
  - Confirm no `Invalid API key` or `connection refused` errors

- [ ] **8.5** Confirm rollback syntax (dry run — do not actually roll back unless needed):
  ```bash
  vercel rollback --help
  ```
  To perform an actual rollback:
  ```bash
  vercel rollback [deployment-url]
  ```

---

## Files Created/Modified

| File | Action | Notes |
|---|---|---|
| `context/changes/deployment/deployment-plan.md` | **Created** | This file — deployment audit trail |
| `.vercel/project.json` | **Auto-created** by `vercel link` | Gitignored — do not commit |
| `.env.local` | **Created locally** | Gitignored — holds Supabase + OpenRouter secrets |
| `src/lib/supabase/client.ts` | **Create** (Phase 4d) | Browser Supabase client |
| `src/lib/supabase/server.ts` | **Create** (Phase 4d) | Server-only admin Supabase client |
| `package.json` | **Conditionally modify** | Add `@supabase/supabase-js`, `@supabase/ssr`; add `engines.node` only if Vercel picks wrong Node |

No `vercel.json` needed — Vercel's zero-config Next.js detection handles everything for MVP.

---

## Risk Register (from `context/foundation/infrastructure.md`)

| Risk | Likelihood | Mitigation during deploy |
|---|---|---|
| Node.js version mismatch | Low | Add `"engines": {"node": "20.x"}` to `package.json` if Vercel picks wrong version |
| Tailwind v4 PostCSS build failure | Low | Check build log for `@tailwindcss/postcss` errors |
| `service_role` key leaked to client | Low | Never use `NEXT_PUBLIC_` prefix; rotate immediately if leaked |
| Supabase peer dep conflict with React 19 | Low | Use `--legacy-peer-deps` if `npm install` fails |
| Cold start latency (~100–500ms) | Medium | Accept for MVP; monitor via Vercel Analytics |
| LLM timeout (future) | Medium | Not a concern at this scaffold stage; revisit when OpenRouter is wired |

---

## Operational Runbook (post-deploy)

| Operation | Command |
|---|---|
| Tail live logs | `vercel logs --follow` |
| Fetch specific deployment logs | `vercel logs [deployment-url]` |
| Rollback to previous deploy | `vercel rollback [deployment-url]` |
| Pull env vars locally | `vercel env pull .env.local` |
| Trigger manual deploy | `vercel --prod` |
| List deployments | `vercel ls` |

---

## Verification Checklist

The deployment is considered successful when all of the following are true:

- [ ] Supabase project provisioned and credentials collected (Phase 4a–4b)
- [ ] `@supabase/supabase-js` and `@supabase/ssr` installed (Phase 4c)
- [ ] All env vars added in Vercel dashboard (Phase 5)
- [ ] `npm run build` exits 0 locally (Phase 6)
- [ ] `npm run lint` exits 0 locally (Phase 6)
- [ ] Production URL loads in browser with no console errors (Phase 8)
- [ ] Vercel Dashboard shows "Ready" status (Phase 8)
- [ ] A test PR generates a preview URL via Vercel bot comment (Phase 8)
- [ ] `vercel logs --follow` shows no errors on page load (Phase 8)
