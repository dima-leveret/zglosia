# Public Form URL + QR Code (S-05) — Plan Brief

> Full plan: `context/changes/public-form-url-qr/plan.md`

## What & Why

Roadmap slice S-05 (FR-004, FR-005): the owner needs a public submission-form URL carrying
an **unpredictable** company identifier, plus a QR code for offline distribution — the
sticker, poster and table card the PRD names as how a small business actually collects
feedback. The unpredictability is a security NFR: a sequential id would leak every other
company's link through enumeration.

## Starting Point

The identifier already exists and is already protected. `companies.id` is
`gen_random_uuid()` (F-01's migration), and a compensating migration from the
company-profile review already revoked table-wide `update` so an owner cannot choose their
own id — that migration's comment names S-06's public URL and FR-004 as the reason. What
does not exist: any QR dependency, any route serving the public form, `NEXT_PUBLIC_SITE_URL`
in the environment, and — notably — any test asserting the id is unwritable. The origin
resolver exists but is private to `src/app/login/actions.ts`.

## Desired End State

An owner opens **Form link** from the dashboard and sees their public URL
(`https://<site>/f/<uuid>`), a QR code encoding it, a copy button, SVG and PNG downloads,
and a page that prints as a clean table card. Scanning that code with a phone opens a page
saying the form is not live yet — not a 404 — so a code printed today keeps working when
S-06 ships the real form. Two owners' URLs are unrelated and neither can change their own.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Public identifier | Reuse `companies.id` | Already a v4 uuid with ~122 bits of entropy and an existing column-scoped grant protecting it; two prior artifacts already commit to it. |
| Link rotation | None | The PRD requires generating the link, not revoking it; rotation becomes a new slice if spam ever forces it. |
| QR generation | Server-rendered SVG via `qrcode` | Zero client JS, vector output for print, and it drops into the existing async-server-page pattern. |
| PNG download | Server route handler | `qrcode.toBuffer` uses pngjs, so PNG stays server-side and avoids client canvas conversion entirely. |
| Base URL | Extract the existing `resolveSiteUrl()` | One server-side origin for magic links and form URLs; the origin must never be request-derived (Server Action CSRF only matches Origin against Host). |
| Pre-S-06 gap | Ship a placeholder public route | The URL shape must be permanent before anyone prints a QR; a scan must never hit a raw 404. |
| URL shape | `/f/<uuid>` | Shortest path means a lower-density code that scans reliably from a sticker at distance. |
| Placement | `/dashboard/form-link` sub-page | Matches how company-profile and submission-intake each took a sub-page, inheriting the proxy guard with no config change. |
| Error correction | Level `Q`, not default `M` | Physical wear on a sticker is the realistic failure mode; ~25% damage tolerance for ~10–15% more modules. |
| Verification | Add the missing `companies.id` rewrite guard | This is the slice that makes the id public, and FR-004's protection currently lives only in a grant and a comment. |

## Scope

**In scope:** shared site-URL resolver + public-URL builder; `NEXT_PUBLIC_SITE_URL`
provisioning; `companies.id` rewrite regression test; public placeholder route
`/f/[companyId]`; `/dashboard/form-link` with inline QR, copy button and dashboard nav;
authenticated SVG/PNG download route; print styles.

**Out of scope:** any schema migration; `form_token` and link rotation; the real customer
form, anon insert policy and submission writing (all S-06); rate limiting and bot defence
(PRD Open Question 3); company data on the public page; a separate print route; QR styling
or logos; i18n.

## Architecture / Approach

```
src/lib/site-url.ts ──> buildPublicFormUrl(company.id) ──> https://site/f/<uuid>
                                    │
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
        src/lib/qr.ts (server-only)        /f/[companyId]/page.tsx
        renderQrSvg → inline <svg>         (public placeholder, no DB, no session)
                    │
        /dashboard/form-link/page.tsx  ──> copy-link-button.tsx ('use client')
                    │
        /dashboard/form-link/qr/route.ts (verifySession → getCompany → svg | png)
```

No database change. `getCompany()` already returns `id`, so the DAL is untouched. Isolation
stays where it lives — in Postgres RLS — and the download route derives the company from the
session, never from a query parameter.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Site-URL contract + identifier guard | Shared resolver, URL builder, env var, `companies.id` rewrite test | The guard migration may not be applied remotely — lessons.md records this exact failure twice |
| 2. Public placeholder route | `/f/[companyId]` answering without a session | Accidentally looking the id up turns the route into a membership oracle |
| 3. Owner surface | `/dashboard/form-link` with inline QR, URL, copy, nav | `dangerouslySetInnerHTML` for the SVG needs its safety argument written down |
| 4. Downloads, print, scan verification | SVG/PNG route handler, print styles, phone-scan acceptance | The QR unit test cannot prove decodability — only the phone scan does |

**Prerequisites:** F-01 (done). A local Supabase (`supabase start`) with credentials in
`.env.test.local` for the DB-touching suites, and Vercel project access to set
`NEXT_PUBLIC_SITE_URL`. A phone with a camera for the Phase 4 acceptance check.

**Estimated effort:** ~2 sessions across 4 phases; Phase 2 is the smallest, Phase 4 the
longest.

## Open Risks & Assumptions

- Reusing `companies.id` means a leaked or spammed link cannot be rotated without deleting
  the account. Accepted deliberately; revisit only if S-06's spam question forces it.
- `qrcode@1.5.4` pulls `yargs` in for its CLI — dead weight in the dependency tree, though
  never bundled to the client since the library is imported server-side only.
- Phase 1 touches the auth path when it extracts the resolver, so the magic-link flow must
  be re-verified even though the behaviour is intended to be identical.
- The Clipboard API is gated on a secure context, so the copy button needs a visible
  fallback for plain-HTTP local access.

## Success Criteria (Summary)

- The owner can copy their public form URL and download a QR code for it, and a phone scan
  of that code opens the right page rather than a 404.
- Two owners' URLs are unrelated, and neither owner can rewrite their own identifier — now
  proven by a test rather than by a migration comment.
- No submission path, public or otherwise, is opened by this slice; S-06 inherits a fixed,
  permanent URL contract.
