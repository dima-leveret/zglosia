---
project: ZGŁOSIA
researched_at: 2026-06-22
recommended_platform: Vercel
runner_up: Netlify
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Next.js 16
  runtime: Node.js
---

## Recommendation

**Deploy on Vercel.**

Vercel is the native Next.js 16 platform and the natural choice for ZGŁOSIA. Next.js 16 runs with zero configuration — no adapter required, breaking changes are handled transparently by the platform. Free tier (1M edge requests/month) covers all MVP traffic (10k–100k monthly requests), and you already have hands-on Vercel/Netlify familiarity. The only constraint is no WebSocket support — not a blocker since plan generation is on-demand and request-driven, not streaming.

## Platform Comparison

All six candidate platforms were researched against five agent-friendly criteria: CLI-first maintenance, managed/serverless abstraction, agent-readable documentation, stable/scriptable deployment API, and MCP or first-class Claude integration. Vercel, Netlify, Railway, and Render all scored identically (5/5 on core criteria). Hard filters applied: no platforms disqualified by tech-stack mismatch (all support Node.js/TypeScript) or persistent-connection requirements (none needed for MVP). Soft weights applied: your existing Vercel/Netlify familiarity broke the tie, and Vercel's native Next.js 16 zero-config support over Netlify's untested plugin.

### Scoring Matrix

| Platform | CLI-first | Managed | Agent docs | Stable deploy | MCP | Total |
|----------|-----------|---------|-----------|---------------|-----|-------|
| **Vercel** | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass (GA) | **5/5** |
| **Netlify** | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass (GA) | **5/5** |
| **Railway** | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass (GA) | **5/5** |
| **Render** | ✓ Pass | ◐ Partial | ✓ Pass | ✓ Pass | ✓ Pass (GA) | **4.5/5** |
| **Fly.io** | ✓ Pass | ✓ Pass | ✓ Pass | ✓ Pass | ◐ Partial (experimental) | **4.5/5** |
| **Cloudflare** | ✓ Pass | ✓ Pass | ✓ Pass | ◐ Partial | ✗ Fail | **3.5/5** |

### Shortlisted Platforms

#### 1. Vercel (Recommended)

**Why it won:** Vercel is the official Next.js platform. Next.js 16 runs zero-config — no custom adapter or build setup required. Free tier (1M edge requests/month) fully covers MVP scale. CLI (`vercel deploy`, `vercel logs`, `vercel rollback`) is comprehensive and agent-friendly. Vercel MCP is GA across 13+ AI clients. You already have Vercel/Netlify familiarity, reducing onboarding friction. GitHub Actions auto-deploy-on-merge via Vercel's native integration (no workflow to write).

**Cost:** Free tier covers 10k–100k monthly requests. No cost until scaling past 10M requests/month. Pro tier ($20/user/month) only needed if extending function timeout beyond 300s default or accessing advanced features.

**Timeline fit:** Zero setup friction for MVP — no platform-specific config to learn beyond standard Next.js patterns.

#### 2. Netlify (Runner-up)

**Why it scored second:** Netlify scores identically on all five agent-friendly criteria. Free tier (300 credits/month) covers MVP scale. CLI is comprehensive (`netlify deploy`, `netlify logs`), MCP GA, docs are agent-accessible. However, `@netlify/plugin-nextjs` officially supports only up to Next.js 13.5 — **Next.js 16 compatibility is undocumented and untested in their plugin**. This is a validation risk. If Vercel were unavailable, you would test Netlify locally against Next.js 16 before committing; if validation passes, Netlify is equally viable.

**Cost:** Same as Vercel for MVP scale.

**Timeline risk:** Requires local validation of Next.js 16 before deployment.

#### 3. Railway

**Why it scored third:** Railway is production-ready with strong MCP support (Railway MCP GA + Claude Code plugin) and co-located databases (Postgres, Redis). CLI is comprehensive and scriptable. However, it requires Node 22 (documented workaround: set `"engines": {"node": "22.x"}` in package.json), costs ~$15–30/month post-free-trial, and is unfamiliar territory for you. Better suited for projects needing persistent connections or tighter database integration; for MVP, Vercel's simplicity wins.

**Cost:** Free trial ($5 credit, 30 days). Post-trial: ~$15–30/month for typical MVP workload.

**Timeline fit:** Additional learning curve (railway CLI, Node version override) vs. Vercel's zero-friction setup.

## Anti-Bias Cross-Check: Vercel

### Devil's Advocate — Weaknesses

1. **Next.js 16 internal API unknowns.** Vercel's docs assume standard Next.js patterns; custom adapter usage or edge-case runtime behavior could diverge from expectations. Mitigation: read `node_modules/next/dist/docs` before writing code (already mandated in AGENTS.md).

2. **No WebSocket support.** Vercel Functions are stateless, request-response only. If plan generation shifts from on-demand HTTP calls to streaming SSE or WebSocket in future, Vercel alone is insufficient. Mitigation: current MVP scope has no streaming requirement; accept risk and re-evaluate if scope changes.

3. **Function payload limit (4.5 MB).** Vercel Functions max payload is 4.5 MB. ZGŁOSIA form submissions and LLM plan payloads are unlikely to exceed this, but if bulk-import or file-upload features are added, this could become a hard limit. Mitigation: non-blocking for current scope; re-evaluate if bulk operations are added.

4. **Vendor lock-in on build process.** Vercel builds and optimizes the Next.js app server-side; local dev may diverge from production if the Vercel build pipeline changes between releases. Mitigation: `vercel dev` replicates the Vercel environment locally; use it for critical pre-deploy testing.

5. **Function timeout default (300 seconds).** Vercel's default function timeout is 300s (5 min). Plan generation via LLM could exceed this if the model is slow or the prompt is large. Mitigation: upgrade to Pro tier for 800s timeout, or implement plan generation queueing if timeouts recur (out of scope for MVP).

### Pre-Mortem — How This Could Fail

**Six months later: ZGŁOSIA's Vercel deployment became a bottleneck.**

The team built ZGŁOSIA on Vercel assuming the free tier would scale indefinitely. By month 4, plan-generation requests hit the 300s function timeout consistently because the LLM calls to OpenRouter were slower than expected — a network lag between Vercel's US region and OpenRouter's infrastructure that wasn't apparent in local dev with `vercel dev`. The team scrambled to upgrade to Pro ($20/user/month), but even the 800s timeout was insufficient. Meanwhile, competitive pressure forced them to add streaming plan-generation (real-time progress updates), but Vercel's stateless architecture made streaming expensive (required external WebSocket service). By month 6, they were rebuilding on Railway to get persistent processes, and the Vercel migration became technical debt. Worst case: the 3-week MVP timeline slipped because validating Vercel's timeout behavior required actual LLM traffic, which wasn't tested until production load arrived.

### Unknown Unknowns

- **Vercel Function cold start latency.** Cold-start delays (100–500ms) are not documented per region. For ZGŁOSIA, the first plan-generation request after deploy could appear slow to users. Mitigation: accept cold-start and monitor; if latency is unacceptable, Railway's always-on processes are an alternative.

- **Build artifact footprint.** Next.js 16 with `use cache` and React 19 may produce larger bundles than expected, pushing against Vercel's 250 MB compressed limit. Mitigation: monitor build logs; unlikely to exceed limit unless dependencies bloat.

- **OpenRouter integration edge cases.** Plan generation depends on external OpenRouter API. Vercel's firewall or request throttling may impact OpenRouter latency or success rate. Mitigation: test integration under realistic load; Vercel's error logs (`vercel logs`) will surface API failures.

## Operational Story

How Vercel operates day to day for ZGŁOSIA.

- **Preview deploys:** Every pull request automatically creates a preview URL via Vercel GitHub integration (zero config). Preview URLs are public and unprotected — anyone with the link can view; use Vercel Firewall rules or Vercel Web Analytics to monitor. Fork PRs from external contributors do not create preview URLs (security default). Merge to `main` triggers production deploy automatically.

- **Secrets:** Environment variables live in Vercel's project settings (dashboard) or via `vercel env:pull` to `.env.local` (never commit). Auth tokens (Supabase API key, OpenRouter API key) stored as secrets in Vercel Project → Settings → Environment Variables. At deploy time, vars are injected as build secrets or runtime env vars depending on scope (use `NEXT_PUBLIC_` prefix for client-side exposure only). Rotation flow: update Vercel dashboard → re-deploy or use `vercel --build-cache=none` to bypass cache and re-fetch secrets.

- **Rollback:** Instant rollback via `vercel rollback` (CLI) or Vercel dashboard (Projects → Deployments → select prior version → Promote to Production). Typical rollback time: <10 seconds. Data caveats: database schema changes do not roll back (Supabase migrations are independent); if a deployment includes a breaking DB change, rollback the code but verify the database state matches the prior deployment manually.

- **Approval:** Production deploys to `main` are automatic (GitHub Actions integration). No human gate exists by default. To require approval, configure GitHub branch protection rules (require code review before merge) or use Vercel's Deployment Protection API (advanced, not needed for MVP). Destructive actions (rotate primary secrets, drop Supabase tables, cancel deployments) remain human-only via Vercel dashboard or `vercel` CLI with confirmation prompts.

- **Logs:** Runtime logs accessed via `vercel logs [deployment-url]` (CLI) or Vercel dashboard (Projects → Deployments → Logs). Tail live logs with `vercel logs --follow`. Build-time logs visible in deployment details (dashboard) or via `vercel deploy --verbose` (CLI). Vercel Insights provides performance and error metrics. Supabase logs (auth, query errors) are separate and accessible via Supabase dashboard; set up cross-service observability to surface both.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| LLM plan-generation requests exceed 300s function timeout | Unknown unknowns | Medium | High | Monitor plan-generation latency in production. Upgrade to Pro ($20/mo) for 800s timeout if timeouts recur. Implement timeout alerts via Vercel Monitoring. |
| Next.js 16 breaking changes cause unexpected behavior | Devil's advocate | Low | Medium | Read `node_modules/next/dist/docs` before writing code (mandated in AGENTS.md). Test edge cases locally with `vercel dev` before deploying. |
| Streaming plan-generation becomes required mid-MVP | Pre-mortem | Low | High | Current scope is on-demand (non-streaming). If streaming becomes requirement, document as out-of-scope for MVP or switch to Railway for persistent processes. |
| Vercel Function cold-start introduces perceptible latency | Unknown unknowns | Medium | Low | Accept cold-start (~100–500ms). Monitor via Vercel Analytics. Not a blocker for MVP. |
| Build artifact exceeds 250 MB compressed limit | Unknown unknowns | Very Low | High | Monitor build logs in Vercel dashboard. Unlikely with standard Next.js 16 + dependencies. If exceeded, enable tree-shaking and dynamic imports. |
| OpenRouter API calls fail due to Vercel firewall/throttling | Unknown unknowns | Low | Medium | Test OpenRouter integration under load locally. Vercel logs will surface API errors. Configure OpenRouter error handling and retry logic. |
| Supabase and Vercel secrets get out of sync during rotation | Research finding | Very Low | Medium | Use `vercel env:pull` to fetch current env vars locally, verify match with Supabase dashboard before updating. Automate rotation via GitHub Actions if frequency warrants. |

## Getting Started

1. **Install Vercel CLI:** `npm i -g vercel`
2. **Link project to Vercel:** `vercel link` (or `vercel` in the project root — interactive setup)
3. **Set environment variables in Vercel dashboard:** Project → Settings → Environment Variables. Add `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, etc.
4. **Test locally with Vercel dev:** `vercel dev` (replicates Vercel's production environment). Verify plan-generation flow end-to-end (Supabase auth, OpenRouter LLM calls) before deploying.
5. **Push to main and auto-deploy:** Vercel watches `main` branch via GitHub integration. On merge, Vercel builds and deploys automatically. Monitor deployment status in Vercel dashboard (Projects → Deployments).

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration (not needed for Vercel Functions)
- CI/CD pipeline setup (Vercel handles GitHub integration natively; no custom workflow required for MVP)
- Production-scale architecture (multi-region failover, DDoS protection, SLA commitments, dedicated support tiers)
