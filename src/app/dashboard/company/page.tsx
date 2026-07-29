import Link from 'next/link'

import { getCompany } from '@/lib/dal'

import { CompanyProfileForm } from './company-profile-form'
import { DeleteAccountForm } from './delete-account-form'

/**
 * The company profile surface (FR-002, FR-003). Lives under /dashboard so the
 * existing PROTECTED_PREFIXES guard in src/proxy.ts covers it with no config
 * change; verifySession() inside the DAL is the actual boundary.
 */
export default async function CompanyProfilePage() {
  const company = await getCompany()

  return (
    <main className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-xl flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="text-sm text-zinc-500 underline-offset-4 hover:underline dark:text-zinc-400"
          >
            ← Back to dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Company profile
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Tell us about your business. This context shapes the action plans
            generated from your submissions.
          </p>
        </div>

        {company ? (
          <CompanyProfileForm company={company} />
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No company is provisioned for this account yet.
          </p>
        )}
      </div>

      {/* Outside the profile card on purpose — the destructive path should not
          read as one more control on the edit form. */}
      <div className="w-full max-w-xl">
        <DeleteAccountForm companyName={company?.name ?? null} />
      </div>
    </main>
  )
}
