import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * Root is a redirect only (no landing content in the MVP): authenticated owners
 * go to their dashboard, everyone else to login. Uses getUser() so the decision
 * is made against a revalidated session, never a cookie we blindly trust.
 */
export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  redirect(user ? '/dashboard' : '/login')
}
