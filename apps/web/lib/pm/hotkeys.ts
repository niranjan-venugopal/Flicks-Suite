'use client'

import { useEffect, useRef } from 'react'

/**
 * Shared hotkey hook (PRD v6 §10 groundwork) — the single place the "is the
 * user typing?" guard lives, ending the copy-pasted keydown handlers. The
 * full CommandRegistry (palette + `?` overlay fed from one action table)
 * lands in Sprint 35; every binding migrates onto it then.
 *
 * map keys: 'c', 'shift+t', 'mod+z', 'mod+shift+z', 'arrowdown', … Handlers
 * run only when focus is NOT in an editable element (unless allowInInput).
 */
export type HotkeyHandler = (e: KeyboardEvent) => void

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = (el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

// G-then chord state shared across surfaces: PmGlobalKeys marks `g`; any
// surface whose single-letter binding collides with a chord target (e.g. `i`)
// checks recentG() and yields to navigation.
let lastG = 0
export function markG(): void {
  lastG = Date.now()
}
export function recentG(): boolean {
  return Date.now() - lastG < 900
}

export function useHotkeys(
  map: Record<string, HotkeyHandler>,
  opts: { allowInInput?: string[]; enabled?: boolean } = {},
) {
  const mapRef = useRef(map)
  mapRef.current = map
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (optsRef.current.enabled === false) return
      const combo = comboOf(e)
      const fn = mapRef.current[combo]
      if (!fn) return
      if (isTyping(e.target) && !optsRef.current.allowInInput?.includes(combo)) return
      fn(e)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
