import Link from 'next/link'

import { getCompany } from '@/lib/dal'
import { renderQrSvg } from '@/lib/qr'
import { buildPublicFormUrl } from '@/lib/site-url'

import { CopyLinkButton } from './copy-link-button'

/**
 * The form-link surface (FR-004, FR-005): the public submission URL for the
 * caller's company and the QR code that encodes it.
 *
 * Lives under /dashboard so PROTECTED_PREFIXES in src/proxy.ts covers it with no
 * config change; getCompany() → verifySession() inside the DAL is the actual
 * boundary. The company id is read from the caller's own row, never from a
 * parameter — there is no input to this page at all, which is what makes it
 * impossible to render another tenant's link.
 */
export default async function FormLinkPage() {
  const company = await getCompany()

  // Built before the branch so the QR encoding stays on one code path. Null
  // company means no id to encode; the empty state below renders instead.
  const url = company ? buildPublicFormUrl(company.id) : null
  const qrSvg = url ? await renderQrSvg(url) : null

  return (
    <main className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="text-sm text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            ← Back to dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Form link
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Share this link, or the code below it, so customers can send you
            feedback. It stays the same, so anything you print keeps working.
          </p>
        </div>

        {!company || !url || !qrSvg ? (
          // Same branch both sibling pages render. Reached when the account has
          // no provisioned tenant row: there is no id, so there is no link.
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No company is provisioned for this account yet.
          </p>
        ) : (
          <div className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            {/* The white plate is not styling for its own sake: a QR code needs
                a light quiet zone to be found, so the code keeps its own
                background in dark mode rather than inheriting the card's. */}
            <div className="flex justify-center">
              <div
                // The markup comes from `qrcode` encoding a URL this server
                // built out of a uuid it read from Postgres — no user-supplied
                // string reaches it. Injected as inline SVG rather than an
                // <img> data URL because the print layout resizes it with CSS.
                dangerouslySetInnerHTML={{ __html: qrSvg }}
                className="w-56 rounded-lg bg-white p-3 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
              />
            </div>

            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Your form link
              </h2>
              {/* Selectable, wrapping, and monospaced: the tail is a uuid, and
                  the owner has to be able to check it character by character
                  against whatever they pasted it into. */}
              <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm break-all text-black select-all dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50">
                {url}
              </p>
              <CopyLinkButton url={url} />
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
