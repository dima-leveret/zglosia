---
bootstrapped_at: 2026-06-10T21:51:00Z
starter_id: next
starter_name: Next.js
project_name: zglosia
language_family: js
package_manager: npm
cwd_strategy: subdir-then-move
bootstrapper_confidence: verified
phase_3_status: ok
audit_command: npm audit --json
---

## Hand-off

Verbatim copy of `context/foundation/tech-stack.md`.

Frontmatter:

```yaml
starter_id: next
package_manager: npm
project_name: zglosia
hints:
  language_family: js
  team_size: solo
  deployment_target: Vercel
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
```

### Why this stack

Solo owner shipping ZGŁOSIA in 3 after-hours weeks: owner auth with strict
per-company data isolation (FR-001) and an on-demand LLM step that turns raw
submissions into a saved action plan (FR-011). The custom path was walked and
landed on Next.js — the user picked it over the recommended 10x-astro-starter
for its mainstream, verified, fully agent-friendly React surface (typed,
convention-based, deep training-data corpus, current docs), which matters for a
solo builder leaning on AI assistance. Auth and AI flags are set; payments,
realtime, and background jobs are out of scope per the PRD non-goals — plan
generation runs on-demand, not queued. Deploys to Vercel with GitHub
Actions auto-deploy-on-merge. Note: this repo runs a modified Next.js with
breaking changes vs. stock (see AGENTS.md), so the bootstrapper and any agent
must read node_modules/next/dist/docs before writing code; auth and Postgres
are assembled on top (e.g. Supabase) rather than shipped by the bare starter.

## Pre-scaffold verification

| Signal      | Value                                            | Severity | Notes                                                       |
| ----------- | ------------------------------------------------ | -------- | ----------------------------------------------------------- |
| npm package | create-next-app v16.2.9 published 2026-06-10     | fresh    | resolved from cmd_template (`npx create-next-app@latest`)   |
| GitHub repo | not run                                          | —        | card.docs_url is `nextjs.org/docs`, not a GitHub URL        |

No stale signal. Proceeded.

## Scaffold log

**Resolved invocation**: `npx create-next-app@latest bootstrap-scaffold --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes`
**Strategy**: subdir-then-move
**Exit code**: 0
**Files moved**: 13 (.gitignore, .next, README.md, eslint.config.mjs, next-env.d.ts, next.config.ts, node_modules, package-lock.json, package.json, postcss.config.mjs, public, src, tsconfig.json)
**Conflicts (.scaffold siblings)**: AGENTS.md.scaffold, CLAUDE.md.scaffold
**.gitignore handling**: moved silently (no .gitignore in cwd)
**.bootstrap-scaffold cleanup**: deleted

**Note on temp-dir name**: the standard `subdir-then-move` temp name `.bootstrap-scaffold`
was rejected by `create-next-app` (npm naming forbids a project name starting with a
period — first attempt exited 1, created nothing). Retried with `bootstrap-scaffold`
(no leading dot); same mechanic, files moved up and the temp dir deleted afterward.
This is a temp-dir naming adaptation, not a scaffold failure.

**Note on context/**: cwd `context/` (prd.md, shape-notes.md, tech-stack.md, README.md)
preserved verbatim — the scaffold wrote nothing under `context/`.

## Post-scaffold audit

**Tool**: `npm audit --json`
**Summary**: 0 CRITICAL, 0 HIGH, 2 MODERATE, 0 LOW (total 2)
**Direct vs transitive**: 1 direct / 1 transitive of the 2 moderate findings. 0 CRITICAL/HIGH either direct or transitive.

Audit exit code was 1 (npm exits non-zero when any advisory exists); per the WARN-AND-CONTINUE policy this is informational only and did not halt the run.

#### CRITICAL findings

None.

#### HIGH findings

None.

#### MODERATE findings

- **next** — range `9.3.4-canary.0 - 16.3.0-canary.5`, direct dependency, flagged via its bundled `postcss`. Fix available: `next@9.3.3` (marked semver-major / downgrade — not a realistic fix for a fresh app; resolves naturally as the bundled postcss updates upstream).
- **postcss** (`node_modules/next/node_modules/postcss`) — transitive (via `next`), range `<8.5.10`. Advisory GHSA-qx2v-qp2m-jg93: "PostCSS has XSS via Unescaped `</style>` in its CSS Stringify Output", CWE-79, CVSS 6.1.

#### LOW / INFO findings

None.

## Hints recorded but not acted on

| Hint                    | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| bootstrapper_confidence | verified                                                                                  |
| quality_override        | false                                                                                     |
| path_taken              | custom                                                                                    |
| self_check_answers      | typed: true, from_official_starter: true, conventions: true, docs_current: true, can_judge_agent: true |
| team_size               | solo                                                                                      |
| deployment_target       | Vercel                                                                                    |
| ci_provider             | github-actions                                                                            |
| ci_default_flow         | auto-deploy-on-merge                                                                      |
| has_auth                | true                                                                                      |
| has_payments            | false                                                                                     |
| has_realtime            | false                                                                                     |
| has_ai                  | true                                                                                      |
| has_background_jobs     | false                                                                                     |

v1 surfaces these for the audit trail but takes no compensating action. The `has_auth`
and `has_ai` flags (and the Vercel / GitHub Actions deploy intent) are carried
forward for a future skill to act on — the bare Next.js starter ships neither auth nor
the LLM integration; those are assembled on top per the hand-off rationale.

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history. (Note: this cwd already has a `.git/`.)
- Review the `.scaffold` siblings the conflict policy created (`AGENTS.md.scaffold`, `CLAUDE.md.scaffold`) and decide which version of each file to keep. Your existing `AGENTS.md` carries the "modified Next.js" guidance; the scaffold's copies are the stock starter defaults.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log. Both findings are MODERATE and resolve as the bundled `postcss` updates; no critical action required.
