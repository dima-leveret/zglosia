# Public Submission Form (S-06) — Plan Brief

> Full plan: `context/changes/public-submission-form/plan.md`

## What & Why

Roadmap slice **S-06** (US-02, FR-006): a customer opens the public form URL — from a link
or by scanning the QR code S-05 ships — and sends feedback without an account. The row
lands in `public.submissions` for exactly the company named in the link, marked
`source = 'form'`. This is the product's **only unauthenticated write path**, and the
`anon` privileges it defines are inherited by every later slice.

## Starting Point

The slot was cut deliberately by the two prerequisites, and both left notes saying so.
`submission_source` already declares `'form'` with no writer, and
`20260804171802_submission_intake.sql:104` states the intent outright: *"S-06 adds the
symmetric `anon` policy pinning 'form'."* That same migration already ran
`revoke all … from anon`, so `anon` holds **zero** privileges today. The content-bounds
CHECK is already in Postgres and its comment says S-06 inherits it for free. `/f/<uuid>` is
a live placeholder page with a frozen URL contract. What is missing: any anon grant or
policy, any way for a stranger to learn the company's name, any abuse bound, a session-less
Supabase client, and any Polish copy.

## Desired End State

A customer scans the code on a table card, lands on a Polish page naming the business,
types their complaint, and sends it. The form is replaced by a confirmation with a "send
another" option. The submission is in the owner's list within seconds, badged as coming
from the form. A stale link shows a calm Polish explanation rather than a 404. A script
hammering the endpoint — through the form or straight at PostgREST with the public anon key
— is refused by the database past a cap no real business will reach.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Write mechanism | Server Action + anon RLS client | Keeps isolation in Postgres where every other write already puts it; the DB refuses a bad row even if the app is wrong. |
| Supabase client | New session-less `createPublicClient()` | `createClient()` binds request cookies, so a logged-in owner filling in their own form would execute as `authenticated` and be rejected for `source='form'`. |
| Anon privileges | `insert (company_id, content, source)` only | Narrowest verb and narrowest column set per `lessons.md`; no select, update, delete, or any grant on `companies`. |
| Zero-row seatbelt | Deliberately omitted | `anon` has no select grant so `RETURNING` is impossible — and unnecessary, because a rejected INSERT is loud while only UPDATE/DELETE fail silently. |
| Company identity | `security definer` RPC returning `name` | Exact-match lookup only, never a policy — a readable-by-anon policy on `companies` would dump every tenant in one unfiltered request. |
| Oracle stance | Knowingly relaxed | A valid id now renders differently from an invalid one; at 122 bits that is not an enumeration channel, and it stops a customer losing 2000 typed characters to a dead link. |
| Dead link | Friendly Polish panel, not `notFound()` | A QR sticker outliving its account is realistic; a raw 404 after a scan reads as a broken business. |
| Language | Polish on `/f`, English on the dashboard | This is the one surface an actual Polish customer reads; no i18n framework, the split is documented instead. |
| Fields | Content only | No migration, minimal RODO surface, no friction on the path the PRD demands be frictionless. |
| Provenance | Nothing beyond content/source/created\_at | Data minimisation on an anonymous channel; the throttle is per company so it needs no network identifier. |
| Spam defence | Honeypot + timing + DB cap (30/company/hour) | No vendor or host coupling; the database cap is the only layer that holds against a caller who skips the page entirely. |
| Throttle mechanism | `BEFORE INSERT` trigger raising `PT429` | A `with check` counting the table it inserts into has murky visibility; a trigger can raise a *distinct* SQLSTATE so the action tells throttled from failed without string-matching. |
| Confirmation | Inline thank-you replacing the form | Strongest signal for someone with no account and no receipt; no second public route to build and guard. |
| Owner surface | Unchanged | The source badge and dashboard count from S-02 already render form submissions correctly. |
| Tests | Full anon-negative suite + positive control | First anon privilege in the product; no existing coverage transfers and each denial can regress on its own. |

## Scope

**In scope:** one migration (name-lookup RPC, column-scoped anon insert grant, anon insert
policy pinning `'form'`, rate-limit trigger); regenerated types; session-less public
client; Polish messages; submit Server Action with honeypot/timing/throttle mapping; the
real `/f/[companyId]` page and form component with dead-link branch; `/f` proxy exclusion;
full anon contract suite.

**Out of scope:** contact or category fields and any `submissions` schema change; IP or
user-agent storage; CAPTCHA/BotID/any vendor bot service; every owner-side change (filter,
new-since indicator, notifications — the last a PRD non-goal); a `/thanks` route; an i18n
framework; link rotation; FR-010 editing; pagination; S-03 work.

## Architecture / Approach

```
/f/[companyId]/page.tsx ──rpc──> public_form_company(id) ──> { name } | ∅ (dead link)
        │
        ▼
public-submission-form.tsx ('use client', honeypot + render-ts)
        │  useActionState( submitPublicSubmission.bind(null, companyId) )
        ▼
actions.ts ──> createPublicClient()  [anon key, NO cookies]
        │         insert { company_id, content, source:'form' }   (no .select)
        ▼
Postgres:  policy submissions_insert_public_form  with check (source='form')
           FK company_id            → 23503 on unknown company
           submissions_content_bounds → 23514 on blank/oversize
           enforce_form_submission_rate() trigger → PT429 past 30/hour
```

The action is an honest caller, not a boundary. Every rule that matters is enforced in
Postgres and would hold against a direct PostgREST call with the public anon key. No
`verifySession()`, no `getCompany()`, no session anywhere on this path — that absence is
the security property.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Anon write surface | RPC, column-scoped anon grant, insert policy, rate trigger, regenerated types | The migration isn't done until `migration list --linked` shows it remote — `lessons.md` records this exact failure twice |
| 2. Anon contract tests | Full anon-negative suite, positive control, throttle assertion | Denials must be asserted on the error code, not an empty array — an empty array is also what a granted select with no policy returns |
| 3. Submit path | Session-less client, Polish messages, submit action | Using the cookie-bound client fails *closed*, and only for the logged-in owner testing their own form |
| 4. Page + acceptance | Real form, dead-link branch, proxy exclusion, phone-scan end-to-end | The phone scan is the slice's acceptance test and cannot be automated |

**Prerequisites:** S-02 and S-05 implemented (both done). Supabase CLI linked;
`.env.test.local` for the DB suites (`npm run test:remote`); a local Supabase for the
from-empty reset. A phone with a camera for Phase 4.

**Estimated effort:** ~2 sessions across four phases; Phase 1 and 3 are short, Phase 2
needs the most care per assertion, Phase 4 carries the UI and the acceptance run.

## Open Risks & Assumptions

- **The throttle is per company, so a flooder can exhaust the hourly window and lock out
  genuine customers.** Accepted deliberately: an availability hit on the feedback channel,
  never data loss, and the alternative (per-IP) requires storing a network identifier this
  slice rules out on RODO grounds.
- **PostgREST's `PTxyz` → HTTP status mapping is the one link not verifiable from this
  repo.** Phase 2 asserts on the SQLSTATE the client actually receives rather than assuming
  it, so a wrong guess surfaces before any UI depends on it.
- **The honeypot and timing checks are forgeable** — the elapsed-time field is unsigned.
  Deliberate: signing it needs a secret and key management for a check whose only job is
  stopping unsophisticated bots. The database cap is the real bound.
- **The public form is open to the owner too.** The S-02 pin still prevents forging `'form'`
  rows through an owner's *authenticated session*, but a public form is by definition open
  to anyone, including its owner. Inherent to FR-006, not a regression.
- **`/f` is removed from the proxy matcher.** Performance and resilience only — `/f` was
  never in `PROTECTED_PREFIXES` — but it touches a file every route depends on.
- Two languages now live in one repo with no i18n layer; without the documented split it
  will drift.

## Success Criteria (Summary)

- A customer with no account can scan the QR, see whose form it is, send feedback, and get
  a clear Polish confirmation — and a dead link tells them so before they type anything.
- The submission appears in the right owner's list badged as coming from the form, and in
  no other owner's.
- `npm run test:remote` proves the anon role can do exactly one thing — insert a `'form'`
  row into a real company — and that the hourly cap refuses the rest.
