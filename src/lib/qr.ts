import 'server-only'

import QRCode from 'qrcode'

/**
 * Error correction level `Q` (~25% of the symbol recoverable) rather than the
 * library default `M` (~15%).
 *
 * The distribution channel the roadmap names for S-05 is physical — a sticker, a
 * poster, a card on a table. The realistic failure mode is wear, a scuff or a
 * thumb over one corner, not transmission noise. `Q` costs roughly 10–15% more
 * modules, which at a ~65-character URL still leaves a code that scans easily
 * from arm's length.
 */
export const QR_ERROR_CORRECTION_LEVEL = 'Q' as const

/**
 * Quiet zone in modules. Below ~2 the scanner struggles to find the symbol edge
 * against a printed background; the spec asks for 4, and 2 is the practical
 * floor that still leaves the code compact on screen.
 */
export const QR_MARGIN = 2

/**
 * The QR code for one URL, as inline SVG markup.
 *
 * SVG rather than a raster data URL because the page prints: a vector code
 * scales to whatever physical size the sheet gives it without going soft, and
 * CSS can resize it for `print:` without a second render.
 *
 * Behind a project function, not called inline, so the encoding settings above
 * are decided once — the Phase 4 download route encodes the same URL and must
 * not drift to a second set of literals. The `import 'server-only'` guard is
 * what stops a client component from pulling the encoder into the browser
 * bundle (same guard as src/lib/dal.ts).
 */
export async function renderQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
    margin: QR_MARGIN,
  })
}
