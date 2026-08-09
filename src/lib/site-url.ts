/**
 * The app's absolute origin, and the public URLs built on it.
 *
 * The origin must never be derived from the request. Next's Server Action CSRF
 * check only requires `Origin` to *match* `Host` — it pins neither to our real
 * domain — so a spoofed pair would put an attacker's host into a genuine
 * Supabase email and hand them the one-time token. The same reasoning applies
 * to the public form URL: it is printed onto stickers and encoded into QR
 * codes, so a request-derived host would be baked into physical media.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is the platform-injected production domain
 * (host only, no scheme) — still a server-side value, never request-derived. It
 * backstops a forgotten `NEXT_PUBLIC_SITE_URL` on Vercel so a deploy cannot
 * silently mail out (or print) `http://localhost:3000` links; localhost stays
 * the default only when neither is set (local dev).
 */
export function resolveSiteUrl(): string {
  // Trailing slashes are stripped rather than tolerated: every caller
  // concatenates a rooted path onto this value, so a configured
  // `https://example.com/` would yield `https://example.com//f/<id>`. A wrong
  // URL in an email is a retry; a wrong URL on a printed QR code is landfill.
  const raw =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000')

  return raw.replace(/\/+$/, '')
}

/**
 * Resolved once at import. The environment cannot change under a running
 * process, so re-reading it per call would buy nothing.
 *
 * `resolveSiteUrl` stays exported alongside it because this memoization is
 * exactly what makes the precedence chain untestable: a unit test cannot vary
 * `process.env` after the module has been imported. Tests call the function;
 * application code reads the constant.
 */
export const SITE_URL = resolveSiteUrl()

/**
 * Path prefix for the public submission form (FR-004). Short on purpose — every
 * character lands in the QR code, and a lower-density code scans more reliably
 * from a sticker or a table card at arm's length.
 */
export const PUBLIC_FORM_PATH_PREFIX = '/f'

/**
 * The public form URL for one company.
 *
 * The identifier is `companies.id` — a `gen_random_uuid()` v4 value, which is
 * what satisfies FR-004's "unpredictable, non-enumerable" requirement. It is
 * safe to publish precisely because an owner cannot choose it: the update grant
 * on `companies` covers only the four profile columns
 * (supabase/migrations/20260730190000_narrow_company_write_grants.sql), and
 * tests/isolation.test.ts holds that guard.
 */
export function buildPublicFormUrl(companyId: string): string {
  return `${SITE_URL}${PUBLIC_FORM_PATH_PREFIX}/${companyId}`
}
