# Submission Intake — Plan Brief

> Full plan: `context/changes/submission-intake/plan.md`

## What & Why

Roadmap slice **S-02**. The owner can manually add a submission, browse their company's submissions, and delete one (FR-007, FR-008, FR-009). This is the store the north-star slice reads from — without submissions there is nothing to generate an action plan out of. It is also the first table to key its RLS on `public.current_company_id()`, the helper F-01 built for downstream tenant tables and that no table has used yet.

## Starting Point

`public.companies` is the only table in the product. F-01 gave it RLS on `auth.uid()`, a trigger that auto-provisions one row per user, and the `current_company_id()` helper. S-01 narrowed the owner's write surface to four profile columns and revoked `insert` and `delete` outright — so this slice is the first place either verb is legitimately granted to an owner, and none of the existing test coverage exercises them. The DAL, Server Action, Zod, and `useActionState` patterns are all established and documented in place.

## Desired End State

An owner opens `/dashboard/submissions`, types a customer complaint, and saves it; it appears at the top of the list marked as manually entered. The dashboard shows how many submissions they have. Clicking Delete arms that one row for a confirm/cancel, and confirming removes it permanently. Owner B can neither read, insert into, nor delete from owner A's submissions — and no owner can create a submission claiming to be a customer's form entry, because Postgres refuses it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Source discriminator | Postgres enum `submission_source` | Generates as a `'manual' \| 'form'` union instead of bare `string`, making an invalid source a build error. |
| Source integrity | Insert policy pins `source = 'manual'` | Makes FR-008's origin marking a database guarantee — an owner with a raw anon-key session cannot forge a customer's voice. |
| Field set | `content` only | Matches the PRD's anonymous-client model and lets the LLM derive themes, which is the product's actual promise. |
| Content cap | 2000 chars | Mirrors the existing `DESCRIPTION_MAX`, already framed as an S-03 token budget. |
| Delete | Hard delete, inline two-step confirm | FR-009 as written, keeps S-03's input clean; the confirm prevents a misclick without account-deletion ceremony. |
| Citation grounding | uuid PK, no ordinal column | Zero schema cost now; S-03 numbers at prompt time and must resolve citations back to uuids before saving. |
| Listing | Newest-first, capped at 100 + exact count | No pagination machinery, correct `(company_id, created_at desc)` index from day one, honest rather than silently truncating. |
| Insert grant | Column-scoped `(company_id, content, source)` | RLS cannot express column scope — a table-wide grant would let an owner choose their own `id` and `created_at`. |
| Privilege authority | `revoke all` first, then grant | The linked project auto-exposes new tables, so an additive-only grant block would leave the default ALL-privileges in place and silently void every privilege decision below. |
| No UPDATE anywhere | No policy, no grant, no `updated_at` | FR-010 is parked; editing a customer's words is the thing the PRD says not to do. |
| `anon` surface | Nothing ships for `anon` | The policy is *shaped* so S-06 slots in, but opening a public write path before S-05 designs the unpredictable id would ship the attack surface ahead of its defence. |
| `company_id` provenance | Always from `getCompany()`, never `FormData` | Same invariant `deleteAccount` carries; RLS would reject a forged id, but the application must not be the layer that tries. |
| Testing | Full — schema, isolation, forgery, Zod | First table where `insert` and `delete` are granted, so no existing coverage transfers. |

## Scope

**In scope:** `submission_source` enum; `submissions` table with cascade FK, three RLS policies, column-scoped grants, list index; regenerated types; `SubmissionSchema` and two DAL reads; `/dashboard/submissions` page, add form, list, inline-confirm delete row; create and delete Server Actions; dashboard count + link; schema, isolation, forgery, and Zod tests.

**Out of scope:** editing a submission (FR-010, parked); anything `anon`-facing (S-05/S-06); plan generation (S-03); pagination beyond the cap; soft delete/undo/trash; search, filter, sort; retention, PII redaction, export; spam defences; bulk actions; reworking `/dashboard` into a shell.

## Architecture / Approach

One additive migration creates the enum, table, policies, grants, and index together, so the object arrives in a working state — the rule `lessons.md` records from the F-01 grant gap. Every read and write runs on the RLS-scoped session client; the service-role client appears nowhere in this slice. Postgres scopes tenancy through `company_id = current_company_id()`, and writes add an explicit `company_id` filter plus `.select('id')` as the seatbelt the codebase already established — because a cross-tenant write is a *silent* success with zero rows matched.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema migration | Enum, table, three policies, column-scoped grants, index | Landing on the live cloud DB; the migration isn't done until `migration list --linked` shows it remote |
| 2. Validation + DAL | Regenerated types, `SubmissionSchema`, capped list + count reads | Low; contract-only — but skipping the type regen silently reverts every query to `any` |
| 3. Add + list surface | Page, add form, list with source badge, create action, dashboard wiring | `company_id` must come from the session, never the request |
| 4. Delete path | Inline two-step confirm row + delete action | Hard delete is irreversible; a zero-row delete looks like success without `.select('id')` |
| 5. Isolation & forgery | Cross-tenant denial, positive control, `source='form'` refusal | Denial is silent — a weak assertion passes with the policies dropped |

**Prerequisites:** F-01 and S-01 implemented; Supabase CLI linked; `.env.local` populated; `.env.test.local` for the DB suites (`npm run test:remote`).
**Estimated effort:** ~2 sessions across five phases; 1–2 are short, 3 carries the UI bulk, 5 needs the most care per assertion.

## Open Risks & Assumptions

- The migration lands on the live cloud database with no disposable replay target, and no container runtime is available locally to prove `db reset` from empty (S-01 finding F1). That criterion is recorded as **blocked**, not waived; `migration list --linked` plus four automated privilege-negative assertions are the compensating control.
- The add form's clear-on-success and preserve-on-failure behaviours are coupled through React 19's automatic form reset, whose exact semantics in this Next fork are unverified — Phase 3 must confirm empirically rather than assume.
- `on delete cascade` means account deletion now destroys submissions too. Required for the `auth.users` cascade to work at all, and correct under RODO, but it widens `deleteAccount`'s blast radius as the S-01 brief predicted.
- The two Server Actions have no automated regression guard — Vitest runs without a Next runtime, so the `company_id`-from-session invariant rests on code review, as `deleteAccount`'s does.
- The 100-row cap means an owner past 100 submissions cannot reach older ones to delete them. They still feed S-03; revisit if a tenant actually gets there.
- S-03 inherits a constraint from the citation decision: it must resolve prompt-time indexes to uuids before saving a plan, or its links rot when a submission is deleted.
- `AGENTS.md` claims no test runner is configured — stale since S-01; worth correcting.

## Success Criteria (Summary)

- An owner can add a submission, see it listed newest-first with its source marked, and delete it behind a confirmation — with inline errors when content is blank.
- The dashboard tells the owner how many submissions they have collected and links them to the page.
- `npm run test:remote` proves owner B cannot read, insert into, or delete from owner A's submissions, and that no owner can insert a submission marked as coming from the public form.
