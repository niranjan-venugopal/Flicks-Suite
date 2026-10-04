/**
 * Theme contract (Round O — per-user light theme).
 *
 * Two layers, deliberately separate:
 *   • the PREFERENCE (`system | light | dark`) lives in `users.theme` on the
 *     API and in a localStorage mirror (`flicks-theme`) on each device;
 *   • the RESOLVED theme (`light | dark`) is carried by
 *     `<html data-theme="…">`, which is what `globals.css` and Tailwind's
 *     `darkMode` selector key off. A wrapper `<div data-theme="dark">` re-scopes
 *     a subtree (the public customer pages) because the selector is
 *     `[data-theme="dark"]`, not `:root[…]`.
 *
 * Resolution (founder decision): `light`/`dark` as-is; `system` OR no mirror →
 * `prefers-color-scheme`. Routes matching PUBLIC_DARK_ROUTE_RE are forced
 * dark — the hosted invoice / mandate / form pages paint their own customer
 * palettes and carry their own toggles.
 *
 * NOT a 'use client' module on purpose: the root (server) layout imports
 * PRE_PAINT_SCRIPT from here, and a client boundary would turn that string
 * into a client reference. `useTheme` is only ever called from client
 * components; the zustand store itself is SSR-safe.
 */
import { create } from 'zustand'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_OPTIONS = ['system', 'light', 'dark'] as const

/** localStorage key for the device mirror of the user's preference. */
export const THEME_STORAGE_KEY = 'flicks-theme'

/**
 * Customer-facing routes that stay dark regardless of the signed-in user's
 * preference: hosted invoice/quote (`/inv/:token`, `/inv/:token/print`),
 * mandate (`/sub/:token`), forms (`/f/:token`) and the invoice preview.
 */
export const PUBLIC_DARK_ROUTE_RE = /^\/(inv|sub|f)\/|^\/invoicing\/[^/]+\/preview(\/|$)/

const DARK_MQ = '(prefers-color-scheme: dark)'

function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === 'string' && (THEME_OPTIONS as readonly string[]).includes(v)
}

/** The device mirror, or null when absent/unreadable (SSR, private mode, …). */
export function readMirror(): ThemePreference | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : null
  } catch {
    return null
  }
}

function writeMirror(pref: ThemePreference): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    /* storage blocked — the DOM attribute still carries the theme for this load */
  }
}

/**
 * Resolve a preference to the theme that should paint.
 *   • `pref` omitted → the mirror (null = device setting);
 *   • `pathname` omitted → `location.pathname` on the client.
 * On the server (no window) the answer is `dark`, matching the SSR
 * `<html data-theme="dark">` default so hydration never disagrees.
 */
export function resolveTheme(
  pref?: ThemePreference | null,
  pathname?: string | null,
): ResolvedTheme {
  const hasWindow = typeof window !== 'undefined'
  const path = pathname ?? (hasWindow ? window.location.pathname : '')
  if (path && PUBLIC_DARK_ROUTE_RE.test(path)) return 'dark'
  const p = pref === undefined ? readMirror() : pref
  if (p === 'light' || p === 'dark') return p
  if (!hasWindow || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia(DARK_MQ).matches ? 'dark' : 'light'
}

// ─── Client state (not persisted — the mirror IS the persisted client state) ──

interface ThemeState {
  /** What the person chose (mirror); `system` until the first client re-assert. */
  preference: ThemePreference
  /** What is painting right now; `dark` until the first client re-assert (SSR default). */
  resolved: ResolvedTheme
}

const useThemeStore = create<ThemeState>()(() => ({ preference: 'system', resolved: 'dark' }))

/**
 * Apply a preference: write the mirror, set `<html data-theme>` to the
 * resolved theme and update the store. Returns the resolved theme. Safe to
 * call repeatedly and on the server (no-op there beyond the return value).
 */
export function applyPreference(
  pref: ThemePreference,
  pathname?: string | null,
): ResolvedTheme {
  const preference: ThemePreference = isThemePreference(pref) ? pref : 'system'
  const resolved = resolveTheme(preference, pathname)
  if (typeof window !== 'undefined') {
    writeMirror(preference)
    const root = document.documentElement
    if (root.getAttribute('data-theme') !== resolved) root.setAttribute('data-theme', resolved)
  }
  const s = useThemeStore.getState()
  if (s.preference !== preference || s.resolved !== resolved) {
    useThemeStore.setState({ preference, resolved })
  }
  return resolved
}

/**
 * Re-assert `<html data-theme>` + the store from whatever is known on this
 * device WITHOUT writing the mirror: an empty mirror means "nothing stated
 * yet" (pre-login, a brand-new device, a public page) and must stay empty
 * until the person picks or the server tells us — otherwise a device-derived
 * 'system' would masquerade as a stated preference. Used by ThemeProvider.
 */
export function reassertFromMirror(pathname?: string | null): ResolvedTheme {
  const mirror = readMirror()
  if (mirror) return applyPreference(mirror, pathname)
  const resolved = resolveTheme(null, pathname)
  if (typeof window !== 'undefined') {
    const root = document.documentElement
    if (root.getAttribute('data-theme') !== resolved) root.setAttribute('data-theme', resolved)
  }
  const s = useThemeStore.getState()
  if (s.preference !== 'system' || s.resolved !== resolved) {
    useThemeStore.setState({ preference: 'system', resolved })
  }
  return resolved
}

/**
 * Reconcile with the server after `/me`, `verify-otp` or `select-tenant`.
 * `undefined` (pre-0065 API that does not send `theme`) → no-op; otherwise
 * the server wins whenever it differs from the device mirror.
 */
export function syncThemeFromServer(pref: ThemePreference | null | undefined): void {
  if (!isThemePreference(pref)) return
  if (pref === readMirror()) return
  applyPreference(pref)
}

/** Current preference + resolved theme (client components only). */
export function useTheme(): ThemeState {
  return useThemeStore()
}

// ─── Pre-paint script ─────────────────────────────────────────────────────────

/**
 * Inlined as the FIRST child of <body> by the root layout so the resolved
 * theme lands on <html> before anything paints (no flash of the SSR dark
 * default for light users). Mirrors resolveTheme() exactly; keep the two in
 * sync. Plain ES5, no dependencies, swallows every error.
 */
export const PRE_PAINT_SCRIPT = [
  '(function(){try{',
  'var d=document.documentElement,t;',
  `if(/${PUBLIC_DARK_ROUTE_RE.source}/.test(location.pathname)){t="dark"}`,
  `else{var m=null;try{m=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}`,
  `t=m==="light"||m==="dark"?m:(window.matchMedia&&window.matchMedia(${JSON.stringify(DARK_MQ)}).matches?"dark":"light")}`,
  'if(d.getAttribute("data-theme")!==t)d.setAttribute("data-theme",t)',
  '}catch(e){}})();',
].join('')
