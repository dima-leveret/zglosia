'use server'

import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * Ends the owner's session and returns them to /login. The server client clears
 * the session cookie via its cookie adapter as part of signOut().
 */
export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
