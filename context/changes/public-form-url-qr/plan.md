# Public Form URL + QR Code (S-05) Implementation Plan

## Overview

Give the authenticated owner a surface that shows the public submission-form URL for
their company and a matching QR code, with copy, download (SVG + PNG) and print paths
(FR-004, FR-005). The identifier in that URL must be unpredictable — the NFR that rules
out enumerating other companies' links.

This slice is **owner-facing only**. The customer-facing form itself is S-06. What this
slice ships on the public side is a placeholder page, so that the URL shape is fixed and
permanently valid the moment an owner prints a QR code.

## Current State Analysis

**The unpredictable identifier already exists.** `public.companies.id` is
`uuid primary key default gen_random_uuid()`
(`supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:16`) — a v4 UUID,
~122 bits of entropy, not sequential. FR-004 is satisfied by the column that is already
there.

**Its write surface is already locked.**
`supabase/migrations/20260730190000_narrow_company_write_grants.sql` revoked table-wide
`update` on `companies` and re-granted only
`update (name, industry, description, location)`. That migration's own comment states the
reason in these exact terms: *"S-06 keys the public submission URL on the company
identifier, and PRD FR-004 / the NFR require that identifier to be unpredictable — a
self-chosen id (all-zeros, or one guessed from another tenant) defeats that directly."*
The same rule is recorded in `context/foundation/lessons.md` ("Grants: narrowest verb, and
narrowest column set"). So a prior slice already made this decision; this plan consumes it.

**But nothing tests it.** `tests/isolation.test.ts` has 21 tests and none of them assert
that an owner cannot rewrite their own `companies.id`. The guard exists only as a grant
and a comment. This is the slice that makes the id public, so that gap closes here.

**The origin resolver exists and is security-load-bearing.** `resolveSiteUrl()` in
`src/app/login/actions.ts:20-28` resolves `NEXT_PUBLIC_SITE_URL` →
`VERCEL_PROJECT_PRODUCTION_URL` → `http://localhost:3000`, with an explicit comment that
the value must **never** be derived from the request (Next's Server Action CSRF check only
requires `Origin` to match `Host`; it pins neither to the real domain). The public form URL
has the identical requirement. The function is currently private to the login module, and
`NEXT_PUBLIC_SITE_URL` is **not** present in `.env.local`.

**No QR dependency exists.** `package.json` carries only `@supabase/ssr`,
`@supabase/supabase-js`, `next`, `react`, `react-dom`, `zod`.

**No route serves the public form.** `src/app/` has `login/`, `auth/confirm/`, `dashboard/`
and the root page. A copied link or scanned QR would hit a bare Next 404 today.

**`getCompany()` already returns what this slice needs.** `src/lib/dal.ts:37-51` selects
`id, name, industry, description, location, created_at, updated_at`. No DAL change is
required.

### Key Discoveries:

- `companies.id` is `gen_random_uuid()` — `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:16`
- Column-scoped update grant is the only thing stopping an owner from choosing their own id — `supabase/migrations/20260730190000_narrow_company_write_grants.sql:36-37`
- Origin must never be request-derived — `src/app/login/actions.ts:9-19`
- `PROTECTED_PREFIXES = ['/dashboard']` — `src/proxy.ts:7`. A route under `/f` is public with no config change, while the proxy matcher still runs on it and fails open via the `catch` at `src/proxy.ts:49-57`.
- Sibling-page conventions: `cache()`d DAL reads with **no** explicit owner filter (RLS scopes them, `src/lib/dal.ts:28-36`); a "No company is provisioned for this account yet." branch on every owner page (`src/app/dashboard/company/page.tsx:37-40`, `src/app/dashboard/submissions/page.tsx:61-69`); outcome strings in a `messages.ts` sibling (`src/app/dashboard/submissions/messages.ts`).
- DB-touching suites refuse to run against a non-local host — `tests/support/require-local-db.ts:17-28`
- `qrcode@1.5.4` renders SVG via `toString(text, { type: 'svg' })` and PNG via `toBuffer()` (pngjs, pure JS — no native canvas). It ships **no** types; `@types/qrcode@1.5.6` is required under `strict`.

## Desired End State

An owner logged in at `/dashboard` sees a link to **Form link**. That page shows the
absolute public URL for their company (`https://<site>/f/<their-uuid>`), a QR code
encoding exactly that URL, a copy button, SVG and PNG download buttons, and prints as a
clean table card. Scanning the QR with a phone opens a page that says the form is not live
yet — not a 404. Another owner's URL is not derivable from theirs, and neither owner can
change their own id to make it so.

Verify by: logging in as two owners, confirming the two URLs differ and neither can be
guessed from the other; scanning the QR with a real phone camera; and running the
isolation suite, which now fails if the id ever becomes writable.

## What We're NOT Doing

- **No schema migration.** Unlike every prior slice, this one adds no table, column,
  policy or grant. The identifier and its protection already exist. Do not invent a
  migration for this slice.
- **No `form_token` and no link rotation.** Considered and declined: `companies.id` is
  already unpredictable and already write-protected, and the PRD requires generation, not
  revocation. If spam later forces rotation, that is a new slice with a new column.
- **No anon insert policy, no public form fields, no submission writing.** That is S-06.
  `submissions` grants nothing to `anon` today (`20260804171802_submission_intake.sql`) and
  this slice leaves that closed.
- **No rate limiting or bot defence.** PRD Open Question 3, owned by the user, scoped to S-06.
- **No company data on the public page.** The placeholder shows no name, no branding, and
  does not look up the id — see the oracle note in Phase 2.
- **No separate `/print` route.** Print is Tailwind `print:` variants on the existing page.
- **No QR styling, logo embedding, or colour customisation.** Plain black-on-white.
- **No i18n.** The codebase's UI strings are English today; this slice does not open that split.

## Implementation Approach

Four phases, ordered so the premise is proven before anything is built on it.

Phase 1 establishes the contract: one shared, server-side origin resolver for the whole
app, a URL builder on top of it, and — critically — an executable test that
`companies.id` cannot be rewritten. If that test fails, the identifier decision is wrong
and phases 2–4 are built on sand, so it runs first.

Phase 2 fixes the public URL shape by shipping the route that URL points at. It is small
but it is the phase that makes a printed QR permanently valid.

Phase 3 builds the owner surface: server-rendered QR, no client JS except the copy button.

Phase 4 adds the download and print paths, then the only test that genuinely proves FR-005
— scanning the code with a real phone.

## Critical Implementation Details

**Module-level memoisation vs. testability.** `src/app/login/actions.ts:30` evaluates
`const SITE_URL = resolveSiteUrl()` once at import. Keeping that shape (it is correct —
the value cannot change at runtime) means a unit test cannot vary `process.env` without
module resets. Export **both**: `resolveSiteUrl()` as a pure function that reads
`process.env` on every call, and `SITE_URL` as the memoised constant the app uses. Tests
target the function; production code targets the constant.

**Trailing slash.** `${SITE_URL}/f/${id}` produces a double slash if
`NEXT_PUBLIC_SITE_URL` is set with a trailing `/`. The existing `/auth/confirm`
concatenation has the same latent defect. Normalise once in the resolver — a QR encoding a
`//` URL is printed and unrecoverable.

**The public route must not look the id up.** Phase 2's page takes `companyId` from the
path and does nothing with it. Any lookup that renders differently for a real vs. a fake id
turns the route into a membership oracle over tenant primary keys — the same reasoning that
made `SUBMISSION_DELETE_FAILED` deliberately generic
(`src/app/dashboard/submissions/messages.ts:18-25`). Do not echo the id into the page body
either.

**Error correction level `Q`, not the default `M`.** The roadmap names the distribution
channel as sticker and poster (*naklejka, plakat, stolik*). `Q` tolerates ~25% damage
versus `M`'s ~15%, at roughly 10–15% more modules. For a ~65-character URL the code stays
small enough to scan easily, and physical wear is the realistic failure mode.

## Phase 1: Site-URL Contract + Identifier Guard

### Overview

Extract the origin resolver into a shared module, add the public-form URL builder on top
of it, provision the env var, and prove in a test that the identifier this slice is about
to publish cannot be rewritten by its owner.

### Changes Required:

#### 1. Shared site-URL module

**File**: `src/lib/site-url.ts` (new)

**Intent**: One server-side answer to "what is this app's absolute origin", shared by the
magic-link flow and the public form URL, plus the builder that turns a company id into its
public link. Carries over the security comment from `login/actions.ts` verbatim — the
reason the value is not request-derived is the load-bearing part.

**Contract**:
- `export function resolveSiteUrl(): string` — pure, reads `process.env` on each call, precedence `NEXT_PUBLIC_SITE_URL` → `https://${VERCEL_PROJECT_PRODUCTION_URL}` → `http://localhost:3000`, with any trailing slash stripped from the result.
- `export const SITE_URL: string` — `resolveSiteUrl()` evaluated once at import.
- `export const PUBLIC_FORM_PATH_PREFIX = '/f'`
- `export function buildPublicFormUrl(companyId: string): string` — returns `` `${SITE_URL}${PUBLIC_FORM_PATH_PREFIX}/${companyId}` ``.

#### 2. Login action consumes the shared module

**File**: `src/app/login/actions.ts`

**Intent**: Delete the local `resolveSiteUrl` and the local `SITE_URL` const, import
`SITE_URL` from `@/lib/site-url`. Behaviour is unchanged; this removes the second copy
before it can drift from the first.

**Contract**: `emailRedirectTo` still resolves to `` `${SITE_URL}/auth/confirm` ``. No
change to `sendMagicLink`'s signature or return shape.

#### 3. Environment variable

**File**: `.env.local` (gitignored) and the Vercel project settings

**Intent**: Set `NEXT_PUBLIC_SITE_URL` so the resolver's first branch is the one that
answers locally, and so production/preview deploys do not depend on the
`VERCEL_PROJECT_PRODUCTION_URL` backstop alone.

**Contract**: `NEXT_PUBLIC_SITE_URL=http://localhost:3000` locally; the real origin set in
the Vercel dashboard for Production and Preview. `.env*` is gitignored per AGENTS.md — this
is a local + dashboard action, not a committed file.

#### 4. Site-URL unit tests

**File**: `tests/site-url.test.ts` (new)

**Intent**: Cover the resolver's precedence chain, the trailing-slash normalisation, and
the URL shape. No database, so this suite runs anywhere — do not import
`require-local-db` here.

**Contract**: Asserts `resolveSiteUrl()` precedence across the three branches by mutating
and restoring `process.env`; asserts a trailing slash in `NEXT_PUBLIC_SITE_URL` does not
produce `//` in the result; asserts `buildPublicFormUrl(id)` yields `<origin>/f/<id>`.

#### 5. Identifier rewrite guard

**File**: `tests/isolation.test.ts`

**Intent**: Add the missing regression test for FR-004's foundation, in the existing
`companies` describe block alongside the other write-surface tests. An owner holding an
anon-key session must not be able to change their own `companies.id` — the property that
makes the published URL meaningful.

**Contract**: Owner A attempts `update({ id: <a different uuid> }).eq('id', ownerA.companyId)`
through their session client and receives Postgres error code `42501` (refused at the
grant layer, since `update` is granted only on the four profile columns). A follow-up
service-role read confirms the row still carries the original id. Add the symmetric
assertion for `created_at`, which the same grant protects.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- New site-URL unit tests pass: `npm test`
- The `companies.id` rewrite guard asserts `42501` and an unchanged row: `npm test` against a local Supabase
- The grant this slice depends on is applied remotely, not merely committed: `supabase migration list --linked` shows `20260730190000_narrow_company_write_grants.sql` in the remote column

#### Manual Verification:

- Magic-link login still completes end to end after the resolver extraction — request a link, follow it, land on `/dashboard`
- `NEXT_PUBLIC_SITE_URL` is set in the Vercel project for both Production and Preview

**Implementation Note**: The `supabase migration list --linked` criterion is not
ceremony — `context/foundation/lessons.md` records this exact failure twice, where a
migration sat committed but unapplied while the finding it closed was live in production.
The entire identifier premise of this slice rests on that one migration. After completing
this phase and all automated verification passes, pause here for manual confirmation from
the human before proceeding.

---

## Phase 2: Public Placeholder Route

### Overview

Ship the route the public URL points at, so the URL shape is permanent and a scan never
lands on a raw 404. Deliberately inert: no session, no database, no branching on the id.

### Changes Required:

#### 1. Public form placeholder page

**File**: `src/app/f/[companyId]/page.tsx` (new)

**Intent**: A static page telling a customer the feedback form is not live yet. It exists
to make the printed URL valid, not to do anything. S-06 replaces its body with the real
form.

**Contract**: Default-exported async server component taking
`{ params }: { params: Promise<{ companyId: string }> }` (params is a Promise in this Next
version — see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`).
Renders fixed copy. Does **not** import `@/lib/dal`, does not query Supabase, does not
render `companyId`, and does not call `notFound()` for a malformed id — every id renders
identically.

#### 2. Confirm the route is public

**File**: `src/proxy.ts` (verification only — no edit expected)

**Intent**: Confirm `PROTECTED_PREFIXES` (`['/dashboard']`) does not cover `/f`, so the
route needs no proxy change. The matcher still runs on `/f`, attempts a session refresh and
falls open through the existing `catch` when Supabase is unreachable — which is the correct
behaviour for a public route and already implemented.

**Contract**: `PROTECTED_PREFIXES` unchanged. If an edit turns out to be required, that is
a signal the route path is wrong, not that the guard needs widening.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds and lists `/f/[companyId]` in the route output: `npm run build`

#### Manual Verification:

- Visiting `/f/<a real company uuid>` while logged out renders the placeholder and does **not** redirect to `/login`
- Visiting `/f/<a random uuid>` and `/f/not-a-uuid` renders byte-identically to the real one — no existence oracle
- The page shows no company name and does not echo the id back

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human before proceeding.

---

## Phase 3: Owner Surface — URL + QR

### Overview

The `/dashboard/form-link` page: the absolute URL, a server-rendered QR code encoding it,
and a copy button. Everything renders on the server except the clipboard interaction.

### Changes Required:

#### 1. QR dependency

**File**: `package.json`

**Intent**: Add QR generation. `qrcode` renders both SVG and PNG server-side with no native
canvas (pngjs), which is what keeps the page free of client-side QR code.

**Contract**: `qrcode@^1.5.4` in `dependencies`; `@types/qrcode@^1.5.6` in
`devDependencies` — the package ships no types and `strict` is on.

#### 2. QR rendering helper

**File**: `src/lib/qr.ts` (new)

**Intent**: Wrap `qrcode` behind the project's own function so the error-correction level
and margin are decided once rather than at each call site, and so a client component cannot
import the library by accident.

**Contract**: `import 'server-only'` at the top (same guard as `src/lib/dal.ts:1`).
`export async function renderQrSvg(text: string): Promise<string>` returning the SVG markup
from `QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 })`.
Export the options object (or the individual constants) so the Phase 4 PNG path encodes
with identical settings rather than a second set of literals.

#### 3. Owner form-link page

**File**: `src/app/dashboard/form-link/page.tsx` (new)

**Intent**: The FR-004/FR-005 surface. Reads the caller's own company through the DAL,
builds the public URL from its id, renders the QR inline, and shows the URL as selectable
text next to the copy button.

**Contract**: Default-exported async server component. Calls `getCompany()` and renders the
same `No company is provisioned for this account yet.` branch its two sibling pages use when
it returns null. Layout follows `src/app/dashboard/submissions/page.tsx:42-59` — back-link,
`h1`, lead paragraph, card.

The SVG string is injected with `dangerouslySetInnerHTML` rather than an `<img>` data URL,
because the print styles in Phase 4 need to size the SVG with CSS. This is safe and worth a
comment saying why: the markup comes from `qrcode` encoding a URL this server built from a
uuid it read out of Postgres — no user-supplied string reaches it.

#### 4. Copy-to-clipboard control

**File**: `src/app/dashboard/form-link/copy-link-button.tsx` (new)

**Intent**: Copy the absolute URL in one click. Hand-selecting a 36-character uuid is
exactly where transcription errors happen.

**Contract**: `'use client'`. Takes the URL as a prop. Writes via `navigator.clipboard`,
shows a transient confirmation, and degrades to a visible fallback (select-the-text hint or
a `document.execCommand` path) when the Clipboard API is unavailable — it is gated on a
secure context, so plain-HTTP local access has no clipboard.

#### 5. Outcome strings

**File**: `src/app/dashboard/form-link/messages.ts` (new)

**Intent**: Shared copy for the surface, following the sibling convention that keeps strings
out of components and out of `'use server'` modules.

**Contract**: Exports the copy-success and copy-failure strings consumed by the button.

#### 6. Dashboard navigation

**File**: `src/app/dashboard/page.tsx`

**Intent**: Add the entry point. Without it the surface is unreachable.

**Contract**: A `<Link href="/dashboard/form-link">` inside the existing `company ?` branch,
styled as the secondary button alongside the submissions link (`src/app/dashboard/page.tsx:83-90`).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- QR helper unit test passes: `npm test` — asserts `renderQrSvg` returns `<svg`-rooted markup, is deterministic for one input, and differs for two different inputs

#### Manual Verification:

- `/dashboard/form-link` shows the absolute URL and a rendered QR code
- The copy button copies the exact URL shown and confirms visibly
- The dashboard shows the new "Form link" entry, and it navigates correctly
- Logging in as a second owner shows a different URL and a different QR
- With no company provisioned, the page renders the same empty-state branch as its siblings rather than throwing

**Implementation Note**: The QR unit test asserts determinism and input-sensitivity, not
decodability — `qrcode` ships no decoder, so genuine encoding verification is the phone
scan in Phase 4. Do not write a criterion claiming more than the test proves. After
completing this phase and all automated verification passes, pause here for manual
confirmation from the human before proceeding.

---

## Phase 4: Downloads, Print, and Scan Verification

### Overview

The distribution paths: SVG and PNG downloads through an authenticated route handler, a
print layout, and the real acceptance test — scanning the code with a phone.

### Changes Required:

#### 1. Authenticated QR download route

**File**: `src/app/dashboard/form-link/qr/route.ts` (new)

**Intent**: Serve the QR as a downloadable file in both formats. A route handler rather
than client-side canvas conversion, because `qrcode.toBuffer` produces the PNG server-side
via pngjs — keeping the zero-client-JS property and avoiding canvas entirely.

**Contract**: `export async function GET(request: NextRequest)`. Calls `verifySession()`
then `getCompany()`, and builds the URL from the session-derived company id — **never** from
a query parameter. Reads `?format=`, accepting `svg` (default) and `png`; anything else
returns 400. Responds with `Content-Type: image/svg+xml` or `image/png` and
`Content-Disposition: attachment; filename="zglosia-qr.<ext>"`. PNG comes from
`QRCode.toBuffer(url, { type: 'png', width: 1024, ... })` using the same error-correction
and margin settings Phase 3 exported.

Lives under `/dashboard`, so `PROTECTED_PREFIXES` covers it — but `verifySession()` inside
the handler is the actual boundary, exactly as documented for the sibling pages and Server
Actions (`src/app/dashboard/submissions/actions.ts:22-26`).

Reading `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`
before writing this file is required by AGENTS.md; the Buffer body should be handed to
`Response` as a `Uint8Array`.

#### 2. Download controls

**File**: `src/app/dashboard/form-link/page.tsx`

**Intent**: Two plain anchors pointing at the route with `?format=svg` and `?format=png`.
No client JS — `Content-Disposition` on the response does the work.

**Contract**: Anchors styled as the existing secondary buttons. The `download` attribute is
redundant given the header; keep the header authoritative so a direct hit on the URL also
downloads.

#### 3. Print layout

**File**: `src/app/dashboard/form-link/page.tsx`

**Intent**: Make Ctrl-P produce the table card the roadmap describes, without a second route.

**Contract**: Tailwind v4 `print:` variants on the existing markup — hide the back-link,
buttons and help text; enlarge the QR to a scannable physical size; keep the company name
(when present) and the URL as text beneath the code.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Full suite green against a local Supabase: `npm test`

#### Manual Verification:

- `?format=svg` downloads an attachment that opens in a vector tool
- `?format=png` downloads a raster image at print resolution
- An unrecognised `?format=` value returns 400
- A logged-out request to the QR route redirects to `/login` rather than serving a code
- Requesting the route while logged in as owner B yields owner B's code — the query string cannot select another company's
- **Scanning the on-screen and printed QR with a phone camera opens `/f/<the owner's uuid>` and shows the placeholder** — the acceptance test for FR-005
- Print preview shows the QR and company name with the page chrome hidden

**Implementation Note**: The phone scan is the only step that proves the code encodes the
right URL. Do not mark this phase complete on the automated criteria alone. After
completing this phase and all automated verification passes, pause here for manual
confirmation from the human.

---

## Testing Strategy

### Unit Tests:

- `resolveSiteUrl()` precedence across `NEXT_PUBLIC_SITE_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, and the localhost default
- Trailing-slash normalisation — a configured origin ending in `/` must not yield `//` in the built URL
- `buildPublicFormUrl(id)` shape
- `renderQrSvg` returns `<svg`-rooted markup, deterministic per input, different across inputs

### Integration Tests:

- `companies.id` rewrite refused with `42501`, row unchanged (added to `tests/isolation.test.ts`)
- `companies.created_at` rewrite refused by the same grant
- These join the DB-touching suites behind `tests/support/require-local-db.ts` — they need `supabase start` and credentials in `.env.test.local`

### Manual Testing Steps:

1. Log in, open `/dashboard/form-link`, confirm the URL matches `<origin>/f/<uuid>` with no double slash
2. Copy the link, paste it into a browser, confirm the placeholder loads while logged out
3. Scan the QR with a phone camera, confirm it opens the same placeholder
4. Download SVG and PNG, open both, confirm the SVG scales cleanly and the PNG is print-sized
5. Print-preview the page, confirm the chrome is hidden and the code is large
6. Log in as a second owner, confirm a different URL and QR
7. Hit `/dashboard/form-link/qr?format=exe` and confirm a 400
8. Log out and hit `/dashboard/form-link/qr?format=png`, confirm the redirect to `/login`

## Performance Considerations

QR generation is CPU work on every render of the form-link page, but the input is a
constant per company and the encoded string is ~65 characters — sub-millisecond, and the
page is behind auth with no traffic profile worth caching against. Not worth memoising in
this slice.

The `/f/[companyId]` placeholder does no I/O at all, which is the point: the public route
is the one an attacker can hit without a session, and it touches neither Supabase nor the
DAL.

## Migration Notes

**This slice ships no migration.** Every prior slice added one, so the absence is a
decision, not an oversight: the identifier (`companies.id`) and the grant that protects it
(`20260730190000_narrow_company_write_grants.sql`) already exist. The only database-related
work here is the Phase 1 verification that the existing migration is applied remotely.

If implementation reaches for a schema change, stop — it means the reused-identifier
decision is being revisited, and that is a planning question, not an implementation one.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-05)
- Change identity: `context/changes/public-form-url-qr/change.md`
- Lessons that constrain this plan: `context/foundation/lessons.md` (all three entries)
- Identifier and its grant: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:16`, `supabase/migrations/20260730190000_narrow_company_write_grants.sql:36-37`
- Origin-resolution precedent: `src/app/login/actions.ts:9-30`
- Sibling owner surface to mirror: `src/app/dashboard/submissions/page.tsx`
- Isolation-test harness: `tests/isolation.test.ts`, `tests/support/require-local-db.ts`
- Next route handlers: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Site-URL Contract + Identifier Guard

#### Automated

- [x] 1.1 Type checking passes: `npx tsc --noEmit` — 3585289
- [x] 1.2 Linting passes: `npm run lint` — 3585289
- [x] 1.3 New site-URL unit tests pass: `npm test` — 3585289
- [ ] 1.4 The `companies.id` rewrite guard asserts `42501` and an unchanged row — deferred: no local Supabase; the guards are written in `tests/isolation.test.ts` but unrun
- [x] 1.5 `supabase migration list --linked` shows the narrow-grants migration applied remotely — 3585289

#### Manual

- [x] 1.6 Magic-link login still completes end to end after the resolver extraction — 3585289
- [x] 1.7 `NEXT_PUBLIC_SITE_URL` is set in the Vercel project for Production and Preview — 3585289

### Phase 2: Public Placeholder Route

#### Automated

- [x] 2.1 Type checking passes: `npx tsc --noEmit` — 90d6840
- [x] 2.2 Linting passes: `npm run lint` — 90d6840
- [x] 2.3 Build succeeds and lists `/f/[companyId]` in the route output — 90d6840

#### Manual

- [x] 2.4 `/f/<real uuid>` renders the placeholder while logged out, with no redirect to `/login` — 90d6840
- [x] 2.5 A random uuid and a malformed id render identically — no existence oracle — 90d6840
- [x] 2.6 The page shows no company name and does not echo the id back — 90d6840

### Phase 3: Owner Surface — URL + QR

#### Automated

- [x] 3.1 Type checking passes: `npx tsc --noEmit` — d163f5e
- [x] 3.2 Linting passes: `npm run lint` — d163f5e
- [x] 3.3 Build succeeds: `npm run build` — d163f5e
- [x] 3.4 QR helper unit test passes — `<svg`-rooted, deterministic, input-sensitive — d163f5e

#### Manual

- [x] 3.5 `/dashboard/form-link` shows the absolute URL and a rendered QR code — d163f5e
- [x] 3.6 The copy button copies the exact URL shown and confirms visibly — d163f5e
- [x] 3.7 The dashboard shows the new "Form link" entry and it navigates correctly — d163f5e
- [x] 3.8 A second owner sees a different URL and a different QR — d163f5e
- [x] 3.9 With no company provisioned, the page renders the sibling empty-state branch — d163f5e

### Phase 4: Downloads, Print, and Scan Verification

#### Automated

- [x] 4.1 Type checking passes: `npx tsc --noEmit` — b853339
- [x] 4.2 Linting passes: `npm run lint` — b853339
- [x] 4.3 Build succeeds: `npm run build` — b853339
- [ ] 4.4 Full suite green against a local Supabase: `npm test` — deferred, same blocker as 1.4: Docker is unavailable so `supabase start` cannot run. The 3 non-DB suites pass (61 tests, incl. 4 new `renderQrPng` cases); `isolation` and `schema` refuse to run against the remote host by design

#### Manual

- [x] 4.5 `?format=svg` downloads an attachment that opens in a vector tool — b853339
- [x] 4.6 `?format=png` downloads a raster image at print resolution — b853339
- [x] 4.7 An unrecognised `?format=` value returns 400 — b853339
- [x] 4.8 A logged-out request to the QR route redirects to `/login` — b853339
- [x] 4.9 Owner B's request yields owner B's code — the query string cannot select another company's — b853339
- [x] 4.10 Scanning the on-screen and printed QR with a phone opens `/f/<uuid>` and shows the placeholder — b853339
- [x] 4.11 Print preview shows the QR and company name with page chrome hidden — b853339
