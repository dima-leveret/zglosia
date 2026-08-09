import { z } from 'zod'

import { createPublicClient } from '@/lib/supabase/server'

import { PublicSubmissionForm } from './public-submission-form'
import { stampRenderedAt } from './screening'

/**
 * The public submission form (S-06, US-02, FR-006) — the product's only
 * unauthenticated surface, and the only one written in Polish.
 *
 * The route path is frozen: S-05 shipped it so the URL an owner copies and
 * prints into a QR code is valid from the moment it is generated, and by now
 * that code may be on a sticker. This slice replaces the placeholder body; the
 * path and file location do not move.
 *
 * ORACLE STANCE — narrowed on purpose, not drifted. The placeholder promised
 * that every `companyId`, real or random, renders byte-identically: it was
 * never looked up, never echoed, never routed to `notFound()`. That promise is
 * now deliberately relaxed one notch, and the new position is:
 *
 *   - the id IS looked up, through public_form_company() — an exact-match
 *     `security definer` function, never a readable-by-anon policy on
 *     public.companies, which PostgREST would let a stranger read unfiltered;
 *   - the id is still never echoed into the markup, and still never reaches
 *     notFound();
 *   - what a caller can learn is exactly two things: whether an id names a
 *     company, and that company's display name.
 *
 * The trade is worth taking. At 122 bits of entropy (gen_random_uuid) an
 * existence check is not a practical enumeration channel, while what it buys is
 * the guardrail this slice exists for: a customer sees whose form they are on,
 * and is told a link is dead BEFORE typing 2000 characters into it. "No
 * submission is lost" cannot be honoured by a page that cannot tell a live link
 * from a dead one.
 *
 * There is no session here and no DAL. `createPublicClient()` queries as `anon`
 * regardless of who is browsing — see its doc comment for why the absence of
 * cookies is the feature.
 */

/**
 * The segment is matched by the router, not validated by it. Without this a
 * malformed id reaches PostgREST as a 22P02 cast error, which would surface as
 * a database failure on a page a customer is reading; an id that cannot be a
 * uuid names no company, which is the dead-link branch by definition.
 */
const CompanyIdSchema = z.uuid()

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ companyId: string }>
}) {
  const { companyId } = await params

  const { name, isLive } = await resolveCompany(companyId)

  return (
    // lang="pl" because the root layout declares the document English for the
    // owner's dashboard. This subtree is the one a customer reads, and a screen
    // reader has to switch voices for it.
    <main
      lang="pl"
      className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-10 dark:bg-black"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        {isLive ? (
          <>
            <div className="flex flex-col gap-1 text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
                {name ? `Zgłoszenie do: ${name}` : 'Formularz zgłoszeniowy'}
              </h1>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {name
                  ? 'Napisz, co da się poprawić. Firma zobaczy Twoje zgłoszenie w swoim panelu.'
                  : 'Napisz, co da się poprawić. Zgłoszenie trafi do firmy, która udostępniła Ci ten link.'}
              </p>
            </div>
            {/* Stamped on the server at render time — see screening.ts. */}
            <PublicSubmissionForm
              companyId={companyId}
              renderedAt={stampRenderedAt()}
            />
          </>
        ) : (
          // Deliberately not notFound(). A 404 tells a customer standing in a
          // shop with a phone nothing they can act on, and this branch is also
          // reached by a link whose account was deleted — the most likely real
          // cause. Calm, and it names the one thing that fixes it.
          <div className="flex flex-col gap-3 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              Ten formularz jest już nieaktywny
            </h1>
            {/* Phrased without gendered verb forms, same as messages.ts. */}
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Ten link nie prowadzi już do żadnej firmy. Poproś o aktualny link
              albo o nowy kod QR — Twoje zgłoszenie nadal jest ważne.
            </p>
          </div>
        )}
      </div>
    </main>
  )
}

/**
 * Resolves the link to a company, as `anon`.
 *
 * Three outcomes, which is why public_form_company() returns a TABLE rather
 * than a scalar: zero rows means the link is dead, one row with a NULL `name`
 * means the link is live but the owner has not filled in their profile yet, and
 * one row with a name is the ordinary case. A scalar NULL cannot separate the
 * first two, and the page renders different things for each.
 *
 * A transport or database FAILURE is not a dead link, and must not be reported
 * as one: the row insert is a separate request that may well succeed, and the
 * foreign key — not this lookup — is the authority on whether the company
 * exists. So an error falls through to the form with neutral wording rather
 * than telling a customer to stop typing.
 */
async function resolveCompany(
  companyId: string
): Promise<{ name: string | null; isLive: boolean }> {
  if (!CompanyIdSchema.safeParse(companyId).success) {
    return { name: null, isLive: false }
  }

  const supabase = createPublicClient()

  const { data, error } = await supabase.rpc('public_form_company', {
    p_company_id: companyId,
  })

  if (error) {
    console.error('public form company lookup failed:', error.code, error.message)
    return { name: null, isLive: true }
  }

  if (!data || data.length === 0) {
    return { name: null, isLive: false }
  }

  // The generated type says `name: string`, but the column is nullable —
  // handle_new_user() provisions every company row blank at signup, so an owner
  // who has not touched their profile yet has a NULL here.
  const resolved = data[0].name

  return {
    name:
      typeof resolved === 'string' && resolved.trim().length > 0
        ? resolved
        : null,
    isLive: true,
  }
}
