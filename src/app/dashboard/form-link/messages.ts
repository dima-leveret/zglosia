/**
 * Outcome strings for the form-link surface.
 *
 * Same convention as src/app/dashboard/submissions/messages.ts: copy lives in a
 * sibling module rather than inline in the component, so the announcement and
 * any future server-side counterpart read from one source instead of two
 * literals that drift.
 */
export const FORM_LINK_COPIED = 'Link copied.'

/**
 * The failure path is a real one, not a defensive stub: the Clipboard API is
 * gated on a secure context, so an owner reaching the dashboard over plain HTTP
 * on a LAN address has no `navigator.clipboard` at all. The message therefore
 * has to tell them what to do instead of apologising.
 */
export const FORM_LINK_COPY_FAILED =
  'Could not copy automatically. Select the link above and copy it manually.'
