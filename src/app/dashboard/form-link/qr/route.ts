import type { NextRequest } from 'next/server'

import { getCompany, verifySession } from '@/lib/dal'
import { renderQrPng, renderQrSvg } from '@/lib/qr'
import { buildPublicFormUrl } from '@/lib/site-url'

/** Base name for the downloaded file, before the format extension. */
const DOWNLOAD_BASENAME = 'zglosia-qr'

/** The formats this route serves. `svg` is the default when `?format=` is absent. */
const FORMATS = ['svg', 'png'] as const
type Format = (typeof FORMATS)[number]

function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value)
}

const CONTENT_TYPES: Record<Format, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
}

/**
 * Downloads the caller's QR code as a file (FR-005).
 *
 * SECURITY — the encoded URL is built from the company id the *session* resolves
 * to, never from a query parameter. `?format=` is the only caller-supplied input
 * and it selects an encoder, not a tenant; there is deliberately no way to name
 * a company here. Same invariant the submission actions document.
 *
 * The route sits under /dashboard so PROTECTED_PREFIXES in src/proxy.ts covers
 * it, but `verifySession()` below is the actual boundary — the proxy refreshes
 * sessions and fails open, so a route that relied on it would serve a code to a
 * request Supabase could not authenticate.
 */
export async function GET(request: NextRequest) {
  // Redirects to /login when there is no user. In a route handler that throws
  // NEXT_REDIRECT, which Next turns into a 307 — the logged-out caller gets the
  // login page rather than an image.
  await verifySession()

  const requested = request.nextUrl.searchParams.get('format') ?? 'svg'

  if (!isFormat(requested)) {
    // 400 rather than falling back to the default: a caller asking for a format
    // we do not serve should hear that, not silently receive a different file
    // under the name they asked for.
    return new Response(`Unsupported format. Use one of: ${FORMATS.join(', ')}.`, {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const company = await getCompany()

  if (!company) {
    // The same state the page renders as "No company is provisioned for this
    // account yet." — there is no id, so there is no URL and no code to encode.
    return new Response('No company is provisioned for this account yet.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const url = buildPublicFormUrl(company.id)
  const body =
    requested === 'png' ? await renderQrPng(url) : await renderQrSvg(url)

  return new Response(body, {
    headers: {
      'Content-Type': CONTENT_TYPES[requested],
      // The header, not a `download` attribute on the anchor, is what makes
      // this a download — so pasting the URL straight into the address bar
      // saves a file too.
      'Content-Disposition': `attachment; filename="${DOWNLOAD_BASENAME}.${requested}"`,
      // This body is one tenant's link. Nothing between here and the browser
      // may hold a copy that another request could be served.
      'Cache-Control': 'private, no-store',
    },
  })
}
