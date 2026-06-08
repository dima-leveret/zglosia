---
starter_id: next
package_manager: npm
project_name: zglosia
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: verified
  path_taken: custom
  quality_override: false
  self_check_answers:
    typed: true
    from_official_starter: true
    conventions: true
    docs_current: true
    can_judge_agent: true
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: false
---

## Why this stack

Solo owner shipping ZGŁOSIA in 3 after-hours weeks: owner auth with strict
per-company data isolation (FR-001) and an on-demand LLM step that turns raw
submissions into a saved action plan (FR-011). The custom path was walked and
landed on Next.js — the user picked it over the recommended 10x-astro-starter
for its mainstream, verified, fully agent-friendly React surface (typed,
convention-based, deep training-data corpus, current docs), which matters for a
solo builder leaning on AI assistance. Auth and AI flags are set; payments,
realtime, and background jobs are out of scope per the PRD non-goals — plan
generation runs on-demand, not queued. Deploys to Cloudflare Pages with GitHub
Actions auto-deploy-on-merge. Note: this repo runs a modified Next.js with
breaking changes vs. stock (see AGENTS.md), so the bootstrapper and any agent
must read node_modules/next/dist/docs before writing code; auth and Postgres
are assembled on top (e.g. Supabase) rather than shipped by the bare starter.
