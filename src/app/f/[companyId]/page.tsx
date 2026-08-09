/**
 * Public submission-form placeholder (S-05).
 *
 * This route exists so the URL an owner copies — and prints into a QR code —
 * is permanently valid from the moment it is generated. S-06 replaces the body
 * below with the real form; the path shape must not change when it does,
 * because by then the code is on a sticker.
 *
 * Deliberately inert: no session, no Supabase, no DAL. It is the one route in
 * the app an attacker can hit without credentials, and it does no I/O at all.
 *
 * It also must not become a membership oracle over tenant primary keys. Every
 * `companyId` — real, random, or malformed — renders byte-identically: the id
 * is never looked up, never echoed into the markup, and never routed to
 * `notFound()`. Same reasoning that keeps SUBMISSION_DELETE_FAILED generic
 * (src/app/dashboard/submissions/messages.ts).
 */
export default async function PublicFormPlaceholderPage({
  params,
}: {
  params: Promise<{ companyId: string }>
}) {
  // Awaited so the contract is explicit, then discarded. Reading the id here
  // would be the first step toward branching on it — see above.
  await params

  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          This form isn&apos;t live yet
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The feedback form for this link is still being set up. Please check
          back soon — the link will keep working, so there&apos;s no need to
          scan a new code.
        </p>
      </div>
    </main>
  )
}
