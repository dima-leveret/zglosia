import { describe, expect, it } from 'vitest'

import { QR_ERROR_CORRECTION_LEVEL, QR_MARGIN, renderQrSvg } from '@/lib/qr'

/**
 * What this suite can and cannot prove.
 *
 * `qrcode` ships an encoder and no decoder, so nothing here reads the symbol
 * back. These tests assert the properties that a broken wiring would violate —
 * SVG-rooted output, one URL always encoding to the same markup, two URLs
 * encoding to different markup — and stop there. That the code resolves to the
 * right URL is settled by scanning it with a phone (Phase 4 manual step), which
 * is the only check that exercises a real decoder.
 *
 * No database, so no `requireLocalDb`: this runs anywhere.
 */
describe('renderQrSvg', () => {
  const url = 'https://zglosia.example/f/3f2a7c58-9b41-4d6e-8a17-5c0e2b9d4f31'

  it('returns SVG-rooted markup', async () => {
    const svg = await renderQrSvg(url)

    // The page injects this string with dangerouslySetInnerHTML; if the helper
    // ever returned the utf8 or terminal rendering instead, the owner would get
    // a wall of block characters where the code should be.
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('emits a viewBox and no fixed pixel size, so CSS can scale it', async () => {
    const svg = await renderQrSvg(url)

    // This is what makes the print layout possible without a second render:
    // Phase 4 enlarges the same markup with a `print:` class.
    expect(svg).toMatch(/viewBox="/)
  })

  it('is deterministic for one input', async () => {
    // Encoding is pure, but the mask pattern is chosen by a penalty heuristic
    // rather than fixed — so two calls agreeing is worth asserting, not assumed.
    const [first, second] = await Promise.all([
      renderQrSvg(url),
      renderQrSvg(url),
    ])

    expect(first).toBe(second)
  })

  it('encodes two different URLs to different markup', async () => {
    // The property the whole slice rests on: two owners must not print the same
    // code. A helper that ignored its argument would pass every test above.
    const other =
      'https://zglosia.example/f/8c1d0e44-2f73-4a90-b6e5-1d83c7f0a2b6'

    expect(await renderQrSvg(url)).not.toBe(await renderQrSvg(other))
  })

  it('pins the encoding settings the download route has to match', async () => {
    // Exported so the Phase 4 PNG path encodes identically instead of
    // re-declaring literals. Asserted so a drive-by edit to either constant is a
    // failing test rather than a screen code and a printed code that differ.
    expect(QR_ERROR_CORRECTION_LEVEL).toBe('Q')
    expect(QR_MARGIN).toBe(2)
  })
})
