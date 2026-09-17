import type { CSSProperties, ReactNode } from 'react'

// ─────────────────────────────────────────────────────────
// Round M — the one PM page container. Every PM page used to roll its own
// `padding: '22px 26px 64px', maxWidth: 9xx–1120` wrapper, which read
// visibly smaller than the rest of the app. PM now mirrors the dashboard's
// wrapper structure EXACTLY (apps/web/app/(app)/dashboard/page.tsx): the
// OUTER div carries `padding: 28px 32px 64px`, the INNER div carries
// `maxWidth: 1280; margin: 0 auto`. Padding must sit outside the cap —
// padding inside a 1280 cap gives a 1216 px content box at 1920 (a 64 px
// misalignment against every other page), which is what the founder asked
// us to avoid. No clamp either: the rest of the app keeps 32 px gutters on a
// phone, so PM does too. `minWidth: 0` + `width: 100%` let the page shrink
// inside a flex/grid shell without ever forcing horizontal scroll.
// ─────────────────────────────────────────────────────────

export const PM_PAGE_OUTER: CSSProperties = { padding: '28px 32px 64px', width: '100%', minWidth: 0 }
export const PM_PAGE_INNER: CSSProperties = { maxWidth: 1280, margin: '0 auto', width: '100%', minWidth: 0 }
/** @deprecated alias kept for older imports — the outer (padded) box. */
export const PM_PAGE: CSSProperties = PM_PAGE_OUTER

/**
 * PM page container. `wide` lifts the inner max-width cap (kanban board — the
 * columns scroll horizontally by nature and want every pixel). The
 * `data-pm-page` attribute stays on the OUTER div: the live verification
 * script measures outer width minus padding as the content box and its
 * padding-left as the gutter — keep it there.
 */
export function PmPage({ children, wide, style }: { children: ReactNode; wide?: boolean; style?: CSSProperties }) {
  return (
    <div data-pm-page={wide ? 'wide' : 'page'} style={{ ...PM_PAGE_OUTER, ...style }}>
      <div style={wide ? { ...PM_PAGE_INNER, maxWidth: 'none' } : PM_PAGE_INNER}>{children}</div>
    </div>
  )
}
