'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { FORM_LINK_COPIED, FORM_LINK_COPY_FAILED } from './messages'

/** How long the confirmation stays on screen before the live region clears. */
const CONFIRMATION_MS = 3000

/**
 * Copy `text`, returning whether it landed.
 *
 * Two paths because `navigator.clipboard` is gated on a secure context: it is
 * simply absent when the dashboard is opened over plain HTTP (a LAN address
 * during local testing, say). The hidden-textarea + `execCommand` path is
 * deprecated but is the only thing that works there, and it is behind the modern
 * API rather than in front of it — `execCommand` is also the one that can fail
 * silently by returning false.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or a non-focused document — fall through rather than
      // reporting failure while an alternative is still untried.
    }
  }

  const area = document.createElement('textarea')
  area.value = text
  // Off-screen but still selectable. `readOnly` keeps the mobile keyboard from
  // appearing for the instant the element is in the document.
  area.readOnly = true
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()

  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    area.remove()
  }

  return copied
}

/**
 * One-click copy for the public form URL.
 *
 * Worth a component rather than leaving the owner to select the text: the URL
 * ends in a 36-character uuid, and a hand-selected copy that clips one character
 * produces a link that looks right and resolves to nothing. The value copied is
 * the same string the page renders, passed as a prop — never rebuilt here.
 */
export function CopyLinkButton({ url }: { url: string }) {
  const [status, setStatus] = useState('')
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The timeout outlives the click, so an unmount mid-countdown would otherwise
  // set state on a gone component.
  useEffect(() => () => clearTimeout(timeoutRef.current), [])

  const handleClick = useCallback(async () => {
    const copied = await copyToClipboard(url)

    setStatus(copied ? FORM_LINK_COPIED : FORM_LINK_COPY_FAILED)

    clearTimeout(timeoutRef.current)
    // The failure message is instructions, not an outcome — it stays until the
    // owner acts on it. Only the success confirmation is transient.
    if (copied) {
      timeoutRef.current = setTimeout(() => setStatus(''), CONFIRMATION_MS)
    }
  }, [url])

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleClick}
        className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        Copy link
      </button>

      {/* Present from first render, empty until something happens: a live region
          added to the DOM at the same moment its text appears is unreliably
          announced. `empty:hidden` keeps it from reserving space meanwhile. */}
      <p
        role="status"
        className="text-sm text-zinc-600 empty:hidden dark:text-zinc-400"
      >
        {status}
      </p>
    </div>
  )
}
