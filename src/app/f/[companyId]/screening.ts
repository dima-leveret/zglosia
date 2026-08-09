/**
 * The bot screening contract, shared between the form that renders the fields
 * and the action that reads them.
 *
 * Both halves have to agree on two field names and one threshold, and neither
 * can import the other: the form is 'use client', the action is 'use server'
 * (where every export must be an async function). A literal repeated across
 * those two files is how a honeypot silently stops being read — the field keeps
 * rendering, the check keeps passing, and nothing fails.
 *
 * These are speed bumps, not boundaries. The timestamp is rendered unsigned and
 * is therefore forgeable; signing it would need a secret and key management for
 * a check whose only job is to stop unsophisticated bots. What actually bounds
 * the damage is the database cap (enforce_form_submission_rate, 30 per company
 * per hour), which holds against a caller who skips this page entirely and posts
 * straight at PostgREST with the public anon key.
 */

/**
 * A field no human ever fills in, because no human can see it. Named to look
 * worth completing to something reading the DOM rather than the layout.
 *
 * The form hides it with CSS positioning, not `type="hidden"` — a bot skips
 * hidden inputs by definition, which is the one thing that would defeat this.
 */
export const HONEYPOT_FIELD = 'website'

/** Carries the server-render time, in epoch milliseconds, as a string. */
export const RENDERED_AT_FIELD = 'rendered_at'

/**
 * Minimum plausible time between the page rendering and a person having read
 * the heading, typed a complaint, and pressed send. Both ends of this
 * measurement are server clocks — the timestamp is stamped at render, not by
 * the browser — so there is no client clock skew to defend against.
 */
export const MIN_ELAPSED_MS = 3_000
