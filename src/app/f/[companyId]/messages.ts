/**
 * Outcome strings for the public submission form — in Polish, deliberately.
 *
 * This is the only surface in the product an actual customer reads: they arrive
 * from a QR sticker on a table or a link from the business, with no account and
 * no context. The dashboard behind the login stays English, because its single
 * reader is the owner working with this codebase. No i18n framework: one page,
 * one language, hard-coded — a framework would be scaffolding around four
 * strings.
 *
 * They live here rather than in actions.ts for the same reason
 * src/app/dashboard/submissions/messages.ts exists: that module carries
 * 'use server', where every export must be an async function, so a plain string
 * constant cannot go there. The client component compares against the sent
 * message to decide whether to swap the form for the confirmation panel, and
 * comparing against an inlined literal in two files is how those copies drift.
 */

/**
 * Shown in place of the form once a submission lands. Also what the honeypot and
 * timing rejections return: a bot must not learn it was detected, so a screened
 * request is told exactly what a real one is told.
 */
export const PUBLIC_SUBMISSION_SENT =
  'Dziękujemy! Twoje zgłoszenie zostało wysłane.'

/**
 * The generic failure. Never carries the database's own message — a customer
 * cannot act on a SQLSTATE, and the error text is not theirs to see.
 */
export const PUBLIC_SUBMISSION_FAILED =
  'Nie udało się wysłać zgłoszenia. Spróbuj ponownie za chwilę.'

/**
 * The hourly cap (PT429 from enforce_form_submission_rate). Distinguishable from
 * the generic failure — retrying immediately is pointless and the customer
 * should know to come back — and explicitly not blaming them, because nothing
 * they did caused it. Phrased without gendered verb forms.
 */
export const PUBLIC_SUBMISSION_THROTTLED =
  'Ta firma otrzymała ostatnio bardzo dużo zgłoszeń. To nie jest błąd po Twojej stronie — spróbuj ponownie za godzinę.'

/**
 * The one field-level error this form can produce. SubmissionSchema's own
 * messages are English (it is shared with the owner's add form), so the Polish
 * surface substitutes this rather than echoing a validation string the customer
 * would not understand.
 */
export const PUBLIC_SUBMISSION_BLANK = 'Wpisz treść zgłoszenia.'
