# Public Submission Form (S-06) Implementation Plan

## Overview

Roadmap slice **S-06** (US-02, FR-006): a customer opens the public form URL — from a link
or by scanning the QR code S-05 ships — types their feedback, and sends it without an
account. The row lands in `public.submissions` for exactly the company named in the link,
marked `source = 'form'`, and shows up in that owner's list behind the badge S-02 already
built.

This is the product's **only unauthenticated write path**. The `anon` role currently holds
zero privileges on every table; this slice grants the first ones, and every later slice
inherits the shape they take.

## Current State Analysis

The slot for this work was cut deliberately by the two prerequisite slices, and both left
notes saying so.

**What already exists:**

- `public.submissions` with the `submission_source` enum declaring `'form'` — a value with
  no writer since S-02. `supabase/migrations/20260804171802_submission_intake.sql:104`
  states the intent outright: *"S-06 adds the symmetric `anon` policy pinning 'form'."*
- `revoke all on public.submissions from anon, authenticated`
  (`20260804171802_submission_intake.sql:72`) already ran, so `anon` has no privilege on
  the table at all. The migration in Phase 1 is the first thing to grant one.
- `submissions_content_bounds` — a CHECK enforcing length ≤ 2000 and at least one
  non-whitespace character, in Postgres rather than only in Zod
  (`20260804183633_fix_submission_blank_check.sql`). Its predecessor's comment says
  *"S-06 inherits this for free… the writer is an unauthenticated stranger rather than the
  owner, and this constraint is already in place to meet them."*
- `src/app/f/[companyId]/page.tsx` — a placeholder that renders byte-identically for every
  id: it never looks the id up, never echoes it, never calls `notFound()`. The URL shape
  `/f/<uuid>` is frozen, because QR codes carrying it may already be printed.
- `buildPublicFormUrl()` and `PUBLIC_FORM_PATH_PREFIX` in `src/lib/site-url.ts`, built on a
  server-side origin that is never request-derived.
- `SubmissionSchema` (`src/lib/validation.ts:112`) — content-only, `source` deliberately
  absent because provenance is the database's job.
- A real-database Vitest suite (`tests/isolation.test.ts`) with an established idiom:
  every denial is paired with a service-role re-read, and every group carries a positive
  control so a broken-outright feature cannot masquerade as perfect isolation.

**What is missing:** any `anon` grant or policy; any way for an unauthenticated caller to
learn the company's name; any abuse bound; a session-less Supabase client; and any
customer-facing Polish copy.

**Key constraints discovered:**

- **The cookie-bound client is the wrong client here.** `createClient()`
  (`src/lib/supabase/server.ts:24`) binds to request cookies. If the person filling in the
  public form is a logged-in owner in that browser, the insert executes as `authenticated`
  and hits `submissions_insert_own_manual`, whose `with check` pins `source = 'manual'` —
  so it is rejected with 42501. The public path must use a deliberately session-less client
  so the role is always `anon`, regardless of who is browsing.
- **The `.select('id')` seatbelt cannot be reused, and does not need to be.** `anon` gets
  no `select` grant, and `INSERT … RETURNING` requires one. That is acceptable because the
  failure modes are not symmetric: a rejected INSERT is *loud* (42501 from the policy,
  23503 from the FK, 23514 from the CHECK), unlike the silent zero-row UPDATE/DELETE that
  the `.select('id')` idiom exists to catch. Every existing comment about that seatbelt
  (`submissions/actions.ts:69`, `:145`) is about UPDATE/DELETE semantics.
- **A blanket `anon` select policy on `companies` would be a mass-disclosure bug.**
  PostgREST allows an unfiltered select, so any readable-by-anon policy on that table
  hands over every tenant row in one request. The name lookup must be an exact-match
  `security definer` function, never a policy.
- **`lessons.md` records twice** that a migration in the repo is not a migration in the
  database, and that grants must be narrowest-verb *and* narrowest-column. Both apply
  directly here.

## Desired End State

A customer scans the QR code on a table card, lands on a Polish page that says whose
feedback form this is, types their complaint, and sends it. They see a confirmation in
place of the form and can send another. The submission is in the owner's list within
seconds, badged as coming from the form. A stale link — one whose account is gone — shows
a plain Polish explanation rather than a 404. A script hammering the endpoint, whether
through the form or straight at PostgREST with the public anon key, is refused by the
database once it exceeds a cap no real business will reach.

**Verified by:** `npm run test:remote` proving the anon role can insert `'form'` rows into
a real company and nothing else — no reads of submissions or companies, no `'manual'`
inserts, no updates, no deletes, and no writes past the cap — plus a phone scan of the
printed QR ending with a row visible in the owner's dashboard.

### Key Discoveries:

- `supabase/migrations/20260804171802_submission_intake.sql:104` — S-02 names the exact
  policy this slice must add.
- `supabase/migrations/20260804171802_submission_intake.sql:72` — `revoke all … from anon`
  means the grant block in Phase 1 is authoritative, not additive.
- `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:61-75` — the
  `security definer` + `stable` + `set search_path = ''` + `revoke all from public` +
  targeted `grant execute` pattern the new RPC must copy.
- `src/lib/supabase/server.ts:24` — `createClient()` reads cookies; the constraint that
  forces a separate public client.
- `tests/isolation.test.ts:529` — the codebase's own statement of why a denial assertion
  on `error` alone is worthless for granted verbs.
- `src/app/f/[companyId]/page.tsx:10-18` — the no-oracle rationale this slice knowingly
  relaxes, and must document relaxing.

## What We're NOT Doing

- **No contact field, no category, no author name.** Content only, matching both the
  existing columns and the PRD's anonymous-client model. No schema change to `submissions`.
- **No IP address, hashed or otherwise, and no user agent.** Data minimisation on an
  anonymous channel; the throttle is per company, so it needs no network identifier.
- **No CAPTCHA, no Vercel BotID, no vendor bot service.** Honeypot + timing + a database
  cap, and nothing that couples the public path to one host.
- **No owner-side changes.** The source badge and dashboard count already render form
  submissions correctly. No source filter, no new-since indicator, no notification — the
  last is a PRD non-goal.
- **No `/f/<id>/thanks` route.** The confirmation is inline.
- **No i18n framework.** Polish is hard-coded on the public surface; the dashboard stays
  English.
- **No link rotation or revocation.** Carried over unchanged from S-05's decision.
- **No editing of a submission** (FR-010, parked), and no change to the QR or form-link
  surfaces.
- **No pagination or list changes**, and no S-03 work.

## Implementation Approach

Isolation stays in Postgres. The public form's Server Action is an honest caller, not a
boundary: it uses a session-less anon client, and every rule that matters — which company
the row may name, that `source` must be `'form'`, that content is bounded and non-blank,
that the cap has not been exceeded — is enforced by the database and would hold against a
direct PostgREST call with the public anon key.

The company-name lookup is a `security definer` function taking the id as an exact-match
argument and returning at most one row containing only `name`. This is the one deliberate
relaxation of the placeholder's no-oracle stance: a valid id now renders differently from
an invalid one. At 122 bits of entropy that is not a practical enumeration channel, and it
buys the customer the ability to see whose form they are on and the ability to be told a
link is dead *before* typing 2000 characters — which is what the "no submission is lost"
guardrail actually asks for. The relaxation is recorded in the page's own comment so a
future reader does not mistake it for drift.

The throttle is a `BEFORE INSERT` trigger rather than a clause in the policy's `with
check`. A `with check` subquery counting rows on the table being inserted into has murky
visibility semantics, whereas a trigger is unambiguous, and — more usefully — it can raise
a *distinct* SQLSTATE, so the action can tell "you are being throttled" from "something
failed" without matching on an error string.

## Critical Implementation Details

**Role selection is the whole ballgame.** The role a Supabase request runs as is decided by
the JWT the client sends, and `createClient()` sends whatever session cookie is in the
browser. The public form must construct its client from the anon key with no cookie
adapter and `persistSession: false`, so the request always authenticates as `anon`. Getting
this wrong does not fail open — it fails *closed*, and only for logged-in owners testing
their own form, which is exactly the person most likely to test it and least likely to
suspect the client.

**The throttle's SQLSTATE crosses three layers.** PostgREST maps a SQLSTATE of the form
`PTxyz` onto HTTP status `xyz`, so raising `PT429` in the trigger yields an HTTP 429, and
supabase-js surfaces the SQLSTATE on `error.code`. The action branches on that code. This
mapping is the one link in the chain not verifiable by reading this repo, so Phase 2
asserts on the code the client actually receives rather than assuming it — if PostgREST
reports it differently, the test says so before any UI depends on it.

**The honeypot and timing checks are speed bumps, not boundaries.** The elapsed-time field
is rendered unsigned and is therefore forgeable. That is a deliberate trade: signing it
would need a secret and key management for a check whose only job is to stop
unsophisticated bots. The database cap is what actually bounds the damage, and it holds
against a caller who skips the page entirely.

## Phase 1: Anon write surface

### Overview

One migration that leaves the database in a working state on its own: the name-lookup
function, the column-scoped anon insert grant, the anon insert policy pinning `'form'`, and
the throttle trigger — plus regenerated types. Nothing in the application changes yet.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_public_submission_form.sql`

**Intent**: Grant the `anon` role the narrowest privilege that lets a stranger file a
submission against a known company id, and nothing more; give the public page a safe way
to resolve that id to a display name; and bound how fast rows can arrive.

**Contract**: Four objects, in this order.

- `public.public_form_company(p_company_id uuid) returns table (name text)` — `language
  sql`, `security definer`, `stable`, `set search_path = ''`. Body selects `name` from
  `public.companies` where `id = p_company_id`. Returning a *table* rather than a scalar is
  load-bearing: zero rows means the link is dead, one row with a NULL `name` means the link
  is live but the owner has not filled in their profile. A scalar cannot distinguish those,
  and the page renders different things for each. Followed by `revoke all on function …
  from public;` then `grant execute … to anon, authenticated;` — mirroring
  `current_company_id()` at `20260726104601_owner_auth_tenant_isolation.sql:74-75`.
  `authenticated` is included so an owner previewing their own form is not a special case.
- `grant insert (company_id, content, source) on public.submissions to anon;` — column
  scope, per `lessons.md`. A table-wide insert grant would let a stranger choose `id` and
  `created_at`. No `select`, no `update`, no `delete`, and no grant on `public.companies`.
- `create policy "submissions_insert_public_form" on public.submissions for insert to anon
  with check (source = 'form')` — the symmetric partner to
  `submissions_insert_own_manual`. It deliberately does **not** constrain `company_id`: the
  link *is* the capability, and the FK is what rejects an id that names no company. The
  comment must say so, because the asymmetry with the authenticated policy above it is the
  first thing a reader will question.
- `public.enforce_form_submission_rate()` — `plpgsql`, `security definer`, `set search_path
  = ''`, plus a `before insert on public.submissions for each row` trigger. Returns `new`
  immediately unless `new.source = 'form'`, so the owner's manual path is untouched.
  Otherwise counts rows with the same `company_id`, `source = 'form'`, and `created_at >
  now() - interval '1 hour'`, and raises when the count is at or above **30**, using
  `errcode = 'PT429'` and a message safe to log. Naming the count threshold in a comment
  next to the interval keeps the two from drifting.

The rate function is the one place a snippet earns its keep, because the guard order and
the errcode are both easy to get subtly wrong:

```sql
create function public.enforce_form_submission_rate()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  recent_count integer;
begin
  -- Owner-entered rows are not rate limited: they arrive one at a time from a
  -- person who is already authenticated, and capping them would be capping the
  -- product's own feature.
  if new.source <> 'form' then
    return new;
  end if;

  select count(*) into recent_count
  from public.submissions
  where company_id = new.company_id
    and source = 'form'
    and created_at > now() - interval '1 hour';

  -- PT429: PostgREST maps a PTxyz sqlstate onto HTTP status xyz, so this
  -- surfaces as a 429 and reaches supabase-js as error.code = 'PT429'.
  if recent_count >= 30 then
    raise exception 'form submission rate limit exceeded for company %', new.company_id
      using errcode = 'PT429';
  end if;

  return new;
end;
$$;
```

The trigger needs no index beyond `submissions_company_created_idx`
(`20260804171802_submission_intake.sql:126`), which already leads on
`(company_id, created_at desc)` and covers this count exactly.

#### 2. Regenerated database types

**File**: `src/lib/supabase/database.types.ts`

**Intent**: Pick up the new function so `.rpc('public_form_company', …)` is typed rather
than degrading to `any`.

**Contract**: Regenerate with
`npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`, per the
instruction at `src/lib/supabase/server.ts:12`. The `Functions` block gains
`public_form_company` with a `p_company_id: string` argument and a `{ name: string | null
}[]` return.

### Success Criteria:

#### Automated Verification:

- Migration applies against a local database from empty: `supabase db reset`
- Migration is applied remotely: `supabase db push`, then `supabase migration list --linked`
  shows the new file with a non-empty remote column
- Type generation produces a diff containing `public_form_company`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Existing suites still pass: `npm run test:remote`

#### Manual Verification:

- `select has_table_privilege('anon', 'public.submissions', 'select')` returns false, and
  the same for `update` and `delete`
- `select has_table_privilege('anon', 'public.companies', 'select')` returns false
- Owner-facing submission add and delete still work in the running app — the trigger is on
  the table both paths write to

**Implementation Note**: `lessons.md` records twice that a migration in the repo is not a
migration in the database. Do not proceed to Phase 2 until `migration list --linked` shows
the file applied remotely. Pause for manual confirmation before continuing.

---

## Phase 2: Anon contract tests

### Overview

Prove the Phase 1 migration actually did what it says, before any application code depends
on it. This is the first anon privilege in the product, so no existing coverage transfers —
every denial below is a distinct grant or policy that can regress on its own.

### Changes Required:

#### 1. Anon surface suite

**File**: `tests/isolation.test.ts`

**Intent**: Extend the existing real-database suite with a `describe` block for the public
form surface, following the file's established idiom — every denial paired with a
service-role re-read, and a positive control so a broken-outright feature cannot pass as
perfect isolation.

**Contract**: A session-less anon client built with `createClient(url, anonKey, { auth: {
autoRefreshToken: false, persistSession: false } })` and never signed in — that absence is
the point, and deserves a comment. Cases:

- **Positive control**: an anon insert of `{ company_id: ownerA.companyId, content, source:
  'form' }` succeeds, and a service-role read confirms the row exists with
  `source = 'form'` and `company_id` equal to owner A's.
- **Denies `source = 'manual'` from anon** — 42501 from `submissions_insert_public_form`'s
  `with check`. The mirror image of the existing owner-side forgery test at
  `tests/isolation.test.ts:637`, and the reason the enum's two values are not
  interchangeable.
- **Denies an insert naming a company that does not exist** — a random uuid raises 23503
  from the FK.
- **Denies every read**: `from('submissions').select()` and `from('companies').select()`
  both fail on the missing grant (42501). Assert on the error, not on an empty array — an
  empty array would also be what a *granted* select with no matching policy returns, and
  the two must not be confused.
- **Denies update and delete** on `submissions` — 42501 at the grant layer.
- **`public_form_company` resolves a real id to its name, and returns zero rows for a
  random uuid.** Both directions matter: the first is what the page renders, the second is
  what the dead-link branch keys on.
- **Throttle**: insert up to the cap for a dedicated throwaway company, assert the next
  insert fails, and assert on the SQLSTATE the client actually receives — do not hard-code
  `'PT429'` as an assumption without also logging what arrived, since the PostgREST mapping
  is the one link in this chain not verifiable from this repo.
- **Throttle does not touch the owner's manual path**: after the cap is exhausted for that
  company, an authenticated `'manual'` insert on the same company still succeeds.

The throttle cases must use their own owner fixture created inside the block and torn down
after, not `ownerA`/`ownerB` — 30 rows of fixture data on a shared company would poison the
list-shape expectations of neighbouring suites.

### Success Criteria:

#### Automated Verification:

- Full suite passes against a local database: `npm test` with `.env.test.local` pointed at
  `supabase start`
- Full suite passes against the linked project: `npm run test:remote`
- Every new case fails when its policy or grant is temporarily dropped — verify at least the
  `source = 'manual'` denial and the throttle this way, since a test that passes with the
  rule removed is the failure mode `tests/isolation.test.ts:529` warns about
- Linting passes: `npm run lint`

#### Manual Verification:

- The throttle block leaves no fixture rows behind — re-running the suite twice in a row
  produces identical results

**Implementation Note**: Pause for manual confirmation before continuing.

---

## Phase 3: Submit path

### Overview

The server side of the form: a session-less client, Polish outcome strings, and the Server
Action that validates, screens, and writes. No UI yet — this phase ends with a code path
that is complete but unreachable.

### Changes Required:

#### 1. Session-less public client

**File**: `src/lib/supabase/server.ts`

**Intent**: Add a third client alongside `createClient()` and `createAdminClient()` for
requests that must run as `anon` regardless of who is browsing.

**Contract**: `createPublicClient()` — synchronous, built from
`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` via `createSupabaseClient`,
with `auth: { autoRefreshToken: false, persistSession: false }` and no cookie adapter at
all. The doc comment must state why the absence of cookies is the feature: with them, a
logged-in owner filling in their own public form would execute as `authenticated`, hit
`submissions_insert_own_manual`, and be rejected for `source = 'form'`.

#### 2. Public-surface messages

**File**: `src/app/f/[companyId]/messages.ts`

**Intent**: Hold the Polish customer-facing strings, separate from the action for the same
reason `src/app/dashboard/submissions/messages.ts` exists — a `'use server'` module may
only export async functions.

**Contract**: Exports for the sent confirmation, the generic failure, the throttled
message, and the blank-content validation error. A file-level comment stating that this
surface is Polish while the dashboard is English, and why: this is the only page an actual
customer reads. The throttled message must be distinguishable from the generic failure and
must not imply the customer did something wrong.

#### 3. Submit action

**File**: `src/app/f/[companyId]/actions.ts`

**Intent**: Record one customer submission against the company named in the URL.

**Contract**: `submitPublicSubmission(companyId: string, _prevState: FormState<'content'>,
formData: FormData): Promise<FormState<'content'>>` — the `companyId` leading parameter is
supplied by `.bind()` at the call site, so it comes from the route segment rather than from
an editable hidden input. Sequence:

1. Reject when the honeypot field is non-empty, and when the elapsed time since render is
   under ~3 seconds. Both return the *generic success* message without writing — a bot
   should not learn it was detected. Log the rejection server-side.
2. Validate `companyId` with `z.uuid()` and the content with the existing
   `SubmissionSchema` (`src/lib/validation.ts:112`). Echo the submitted text back in
   `values` on failure, exactly as `createSubmission` does at
   `src/app/dashboard/submissions/actions.ts:44`, so a rejection does not erase what the
   customer typed.
3. Insert `{ company_id, content, source: 'form' }` through `createPublicClient()`, with
   **no** `.select()` — `anon` has no select grant, and an INSERT rejection is loud, so the
   zero-row seatbelt the other actions carry has nothing to catch here. Write that
   reasoning down; its absence otherwise reads as an oversight against two sibling actions
   that both have it.
4. Branch on `error.code`: `PT429` → the throttled message; `23503` (unknown company) and
   everything else → the generic failure. Never surface the database's own message.
5. No `revalidatePath` — the owner's list is a per-session dynamic render behind
   `verifySession()`, so there is no shared cache entry for an anonymous request to
   invalidate.

There is no `getCompany()` call and no session anywhere in this file — that absence is the
security property, and is worth a comment given that every other action in the codebase
opens with `verifySession()`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Existing suites still pass: `npm run test:remote`
- `grep` confirms `createPublicClient` is imported by the public action and by nothing
  under `src/app/dashboard/`

#### Manual Verification:

- Reviewed: the action contains no `verifySession`, no `getCompany`, and no `createClient`
- Reviewed: `company_id` reaches the insert from the bound route parameter and from no
  other source

**Implementation Note**: Pause for manual confirmation before continuing.

---

## Phase 4: Public form page and acceptance

### Overview

Replace the placeholder body with the real form, wire the dead-link branch, and verify the
whole slice end to end — from a phone scanning the printed code to a row in the owner's
dashboard.

### Changes Required:

#### 1. Public page

**File**: `src/app/f/[companyId]/page.tsx`

**Intent**: Resolve the link to a company, then render either the form or a dead-link
explanation. Replaces the placeholder body; the route path and file location do not change,
because printed codes already point at them.

**Contract**: `await params`, then call `public_form_company` through `createPublicClient()`
with the id. Zero rows → the dead-link panel (Polish, calm, suggesting the customer ask the
business for a current link), reusing the placeholder's card layout and tone. One row →
the heading naming the company, falling back to neutral wording when `name` is NULL, plus
the form component. The page passes `companyId` and a render timestamp down.

The comment block at the top of the current file must be **rewritten, not deleted**: it
currently promises this route is not a membership oracle, and that promise is now
deliberately narrowed. State the new position — the id is looked up but never echoed, only
existence and a display name are disclosed, and that is accepted at 122 bits of entropy
against the guardrail that a customer must not lose what they typed to a dead link.

#### 2. Form component

**File**: `src/app/f/[companyId]/public-submission-form.tsx`

**Intent**: The customer's form and its confirmation state.

**Contract**: `'use client'`, `useActionState` over `submitPublicSubmission.bind(null,
companyId)`. Follows the two accessibility rules `submission-form.tsx:12-21` documents: no
HTML `required` (native validation would short-circuit the server's field message), and
`role="alert"` + `aria-describedby` on the error. Additions specific to this surface:

- A honeypot input, hidden from sight *and* from assistive technology
  (`aria-hidden`, `tabIndex={-1}`, `autoComplete="off"`), with a name that looks worth
  filling in. Hidden by CSS positioning rather than `type="hidden"` — a bot reads the DOM,
  and `type="hidden"` is the one thing it knows to skip.
- A hidden field carrying the page's render timestamp, read by the action's timing check.
- On success the form is **replaced** by a Polish thank-you panel with a "send another"
  control that resets back to an empty form. This is the confirmation the guardrail
  requires; a cleared textarea is not enough of a signal for someone with no account and no
  receipt.
- `maxLength={SUBMISSION_CONTENT_MAX}` from `src/lib/validation.ts`, same as the owner's
  form, so the browser cap and the server cap cannot drift.

#### 3. Proxy exclusion

**File**: `src/proxy.ts`

**Intent**: Stop running a Supabase session refresh on the one route that has no session.

**Contract**: Add `/f` to the matcher's exclusion pattern, alongside `_next/static` and the
image extensions. The public path currently pays a `getUser()` network round trip on every
scan for a page that reads no session, and it is the one route that must stay fast and must
keep working when Supabase auth is degraded. `PROTECTED_PREFIXES` is untouched — `/f` was
never protected, so this changes performance and not authorization. Note in the comment
that the Server Action on this page POSTs to its own route and is therefore unaffected by
matcher changes either way, which is the same reasoning already recorded at
`src/proxy.ts:3`.

### Success Criteria:

#### Automated Verification:

- Production build succeeds: `npm run build`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Full suite passes: `npm run test:remote`

#### Manual Verification:

- Scanning the QR from `/dashboard/form-link` with a phone opens the form showing the
  correct company name
- Submitting from the phone shows the Polish confirmation, and the row appears in
  `/dashboard/submissions` badged as coming from the form
- "Send another" returns an empty form and a second submission also lands
- Submitting blank or whitespace-only content shows the inline Polish error and preserves
  nothing was lost
- A URL with a random uuid shows the dead-link panel, not a 404 and not a form
- Submitting while logged in as the owner in the same browser still works — the
  session-less-client case
- Owner B's dashboard shows none of owner A's form submissions
- Exceeding the hourly cap shows the throttled message, and the owner's manual add still
  works during that window
- The dashboard remains in English and only the `/f` surface is Polish

**Implementation Note**: The phone scan is the acceptance test for the whole roadmap slice
and cannot be replaced by an automated check. Pause for manual confirmation before closing
the change.

---

## Testing Strategy

### Unit Tests:

- `public_form_company` resolving a real id, and returning zero rows for a random one
- Existing `SubmissionSchema` coverage in `tests/validation.test.ts` already covers the
  content rules and needs no addition — the public form reuses the schema unchanged

### Integration Tests:

All in `tests/isolation.test.ts`, against a real database, since RLS and grants cannot be
proven against a mock:

- Anon can insert `source = 'form'` into a real company (positive control)
- Anon cannot insert `'manual'`, cannot name a non-existent company, cannot read
  `submissions` or `companies`, cannot update, cannot delete
- The hourly cap refuses the insert past the threshold with a distinct SQLSTATE
- The cap does not affect the owner's authenticated manual path

### Manual Testing Steps:

1. Print or display the QR from `/dashboard/form-link`, scan it with a phone, and submit.
2. Confirm the row in `/dashboard/submissions` with the form badge and the dashboard count.
3. Use "send another" and submit a second time.
4. Submit whitespace-only content and confirm the inline Polish error.
5. Open `/f/<random-uuid>` and confirm the dead-link panel.
6. Submit while logged in as the owner in the same browser.
7. Drive past the hourly cap with a script and confirm the throttled message, then confirm
   the owner's manual add still works.
8. Confirm as a second owner that none of the above is visible.

## Performance Considerations

The throttle's count runs on every `'form'` insert and is served by
`submissions_company_created_idx`, which already leads on `(company_id, created_at desc)` —
no new index. The name lookup is a primary-key hit. Removing `/f` from the proxy matcher
strips a `getUser()` network round trip from every public page load, which is the single
largest latency item on that path.

## Migration Notes

One additive, forward-only migration. No data migration and no change to any existing
column, policy, or grant — the S-02 objects are untouched, and the new trigger short-
circuits for `source <> 'form'` so the owner path is unaffected. Rolling back means
dropping the trigger, function, policy, RPC, and grant; no rows need reversing, though rows
already collected through the public form would remain and are indistinguishable from any
other submission apart from their `source`.

## References

- Roadmap slice S-06: `context/foundation/roadmap.md:151`
- Prerequisite S-02: `context/changes/submission-intake/plan.md`, and the anon slot it left
  at `supabase/migrations/20260804171802_submission_intake.sql:104`
- Prerequisite S-05: `context/changes/public-form-url-qr/plan.md`, and the frozen URL
  contract in `src/lib/site-url.ts`
- Recurring rules: `context/foundation/lessons.md`
- Owner-side equivalents to follow: `src/app/dashboard/submissions/actions.ts`,
  `src/app/dashboard/submissions/submission-form.tsx`
- Test idiom: `tests/isolation.test.ts:435-678`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Anon write surface

#### Automated

- [ ] 1.1 Migration applies against a local database from empty (`supabase db reset`)
- [x] 1.2 Migration applied remotely (`supabase db push` + `migration list --linked` shows it) — 8140396
- [x] 1.3 Type generation produces a diff containing `public_form_company` — 8140396
- [x] 1.4 Type checking passes (`npx tsc --noEmit`) — 8140396
- [x] 1.5 Linting passes (`npm run lint`) — 8140396
- [x] 1.6 Existing suites still pass (`npm run test:remote`) — 8140396

#### Manual

- [x] 1.7 `anon` has no select, update, or delete privilege on `public.submissions` — 8140396
- [x] 1.8 `anon` has no select privilege on `public.companies` — 8140396
- [x] 1.9 Owner-facing submission add and delete still work in the running app — 8140396

### Phase 2: Anon contract tests

#### Automated

- [ ] 2.1 Full suite passes against a local database (`npm test`)
- [x] 2.2 Full suite passes against the linked project (`npm run test:remote`) — 1971151
- [ ] 2.3 New cases fail when their policy or grant is temporarily dropped
- [x] 2.4 Linting passes (`npm run lint`) — 1971151

#### Manual

- [x] 2.5 Throttle block leaves no fixture rows behind across consecutive runs — 1971151

### Phase 3: Submit path

#### Automated

- [x] 3.1 Type checking passes (`npx tsc --noEmit`) — b2f4431
- [x] 3.2 Linting passes (`npm run lint`) — b2f4431
- [x] 3.3 Existing suites still pass (`npm run test:remote`) — b2f4431
- [x] 3.4 `createPublicClient` is imported by the public action and nothing under `src/app/dashboard/` — b2f4431

#### Manual

- [x] 3.5 Action contains no `verifySession`, no `getCompany`, and no `createClient` — b2f4431
- [x] 3.6 `company_id` reaches the insert from the bound route parameter and no other source — b2f4431

### Phase 4: Public form page and acceptance

#### Automated

- [x] 4.1 Production build succeeds (`npm run build`) — 0336523
- [x] 4.2 Type checking passes (`npx tsc --noEmit`) — 0336523
- [x] 4.3 Linting passes (`npm run lint`) — 0336523
- [x] 4.4 Full suite passes (`npm run test:remote`) — 0336523

#### Manual

- [x] 4.5 Phone scan of the QR opens the form showing the correct company name — 0336523
- [x] 4.6 Phone submission confirms, and the row appears badged as coming from the form — 0336523
- [x] 4.7 "Send another" returns an empty form and a second submission lands — 0336523
- [x] 4.8 Blank or whitespace-only content shows the inline Polish error — 0336523
- [x] 4.9 A random uuid shows the dead-link panel, not a 404 and not a form — 0336523
- [x] 4.10 Submitting while logged in as the owner in the same browser still works — 0336523
- [x] 4.11 Owner B's dashboard shows none of owner A's form submissions — 0336523
- [x] 4.12 Exceeding the hourly cap shows the throttled message; manual add still works — 0336523
- [x] 4.13 The dashboard remains English and only the `/f` surface is Polish — 0336523
