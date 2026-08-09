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

/**
 * Pixel width of the downloadable PNG.
 *
 * The raster download exists for tools that cannot place an SVG — a word
 * processor, a print shop's upload form. 1024px across a ~41-module symbol is
 * ~25px per module, which still prints crisply at the postcard sizes S-05
 * targets; below a few hundred pixels the modules alias and the code stops
 * scanning off paper.
 */
export const QR_PNG_WIDTH = 1024

/**
 * The same QR code as `renderQrSvg`, rasterised.
 *
 * `qrcode` renders PNG through pngjs, in pure JS — no `node-canvas`, no native
 * build. That is the reason this can run inside a route handler at all, and the
 * reason the download path needs no client-side canvas step.
 *
 * Returned as a `Uint8Array` over a plain `ArrayBuffer` rather than the `Buffer`
 * the library hands back. `Response` takes a `BodyInit`, which a Node `Buffer`
 * only incidentally satisfies — its backing store is typed `ArrayBufferLike`
 * (it may sit in a `SharedArrayBuffer`), and `BodyInit` does not accept that.
 * Copying into a fresh buffer is a few kilobytes and makes the type honest
 * rather than casting the mismatch away.
 */
export async function renderQrPng(
  text: string
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await QRCode.toBuffer(text, {
    type: 'png',
    // Identical to the SVG path on purpose — the printed code and the code on
    // screen have to be the same symbol, not two encodings that happen to
    // resolve to the same URL.
    errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL,
    margin: QR_MARGIN,
    width: QR_PNG_WIDTH,
  })

  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)

  return bytes
}
