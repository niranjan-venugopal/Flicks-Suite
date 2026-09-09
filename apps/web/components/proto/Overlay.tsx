'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface OverlayProps {
  open: boolean
  /** Scrim click. Omit for overlays that must not dismiss on the backdrop. */
  onClose?: () => void
  /** 900–1299 band (globals.css layering scale). */
  zIndex?: number
  /** Vertical placement of the face inside the viewport. */
  align?: 'center' | 'start' | 'end'
  /** Gutter around the face — any CSS padding value. */
  padding?: number | string
  /** Backdrop blur radius in px; 0 renders a plain dim with no filter. */
  blur?: number
  /** Scrim opacity, 0–1. */
  dim?: number
  /** Accessible name for the overlay root — usually the dialog title. */
  label?: string
  children: ReactNode
}

/** document.body only exists after hydration — render nothing on the server pass. */
function useMounted() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}

/**
 * Round K — the one full-screen overlay primitive. Portals to <body> so the
 * scrim covers the real viewport: rendered in-tree it sat inside page shells
 * that wrap content in `position: relative; zIndex: 1` (InvoPage and ~15
 * others), which trapped it under the sticky Topbar and Sidebar.
 *
 * Two fixed SIBLINGS at the same z (the Radix Dialog shape), never a card
 * nested inside a blurred scrim: a backdrop-filter inside a backdrop-filter
 * ancestor composites unreliably. The root is pointer-events:none so its
 * gutters fall through to the scrim (the real click target); every direct
 * child gets pointer-events:auto back via `.overlay-root > *` in globals.css,
 * which also re-arms clicks while a Radix dialog has set pointer-events:none
 * on <body>.
 *
 * Faces keep their own `onClick={e => e.stopPropagation()}` where an ancestor
 * is clickable — React portals bubble through the React tree, not the DOM.
 */
export function Overlay({
  open,
  onClose,
  zIndex = 1000,
  align = 'center',
  padding = 24,
  blur = 8,
  dim = 0.6,
  label,
  children,
}: OverlayProps) {
  const mounted = useMounted()
  if (!open || !mounted || typeof document === 'undefined') return null

  const filter = blur > 0 ? `blur(${blur}px)` : undefined

  return createPortal(
    <>
      <div
        data-overlay-scrim
        className="overlay-scrim"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex,
          background: `rgba(0,0,0,${dim})`,
          WebkitBackdropFilter: filter,
          backdropFilter: filter,
        }}
      />
      <div
        data-overlay-root
        className="overlay-root"
        role="presentation"
        aria-label={label}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex,
          display: 'flex',
          justifyContent: 'center',
          alignItems: align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : 'center',
          padding,
          pointerEvents: 'none',
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  )
}
