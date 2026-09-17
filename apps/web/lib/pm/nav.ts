// ─────────────────────────────────────────────────────────
// Round L — "Back to origin". An issue page is reached from many lists
// (project, My issues, cycle, triage, the team list, the palette); Back /
// Escape / post-delete must return to the list the person came from, not to
// a hard-coded /pm/issues. The origin rides in `?from=` — an INTERNAL /pm
// path only (open-redirect guard) — and is forwarded, not replaced, across
// sub-issue / relation hops (founder default 12).
// ─────────────────────────────────────────────────────────

/**
 * Internal PM paths only: `/pm/…` with an optional query string, ≤ 200
 * chars, no dots (no `..`, no host-shaped strings), no protocol, no `//`.
 */
export const PM_FROM_RE = /^\/pm\/[\w\-\/]*(\?[\w\-=&%.]*)?$/

export const PM_FROM_MAX = 200

/** The list an issue page falls back to when no (valid) origin was carried. */
export const PM_DEFAULT_ORIGIN = '/pm/issues'

/**
 * The fallback for a deep link (bell, inbox, pasted URL): the issue's OWN
 * team's list, so Back from a team-B issue never lands on team A's list.
 */
export function defaultOrigin(teamId?: string | null): string {
  return teamId ? `${PM_DEFAULT_ORIGIN}?team=${encodeURIComponent(teamId)}` : PM_DEFAULT_ORIGIN
}

/**
 * Validate a raw `from` value. Anything that is not a plain internal PM
 * list path is dropped (null), so `?from=https://evil` and `?from=/settings`
 * fall back to the default. Issue-detail paths are rejected too: the origin
 * is always a LIST, never the previous issue.
 */
export function safeFrom(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (raw.length > PM_FROM_MAX) return null
  if (!PM_FROM_RE.test(raw)) return null
  if (raw.startsWith('/pm//')) return null
  if (/^\/pm\/issues\/[^?]/.test(raw)) return null
  return raw
}

/** Href for an issue page, carrying the (validated) origin when there is one. */
export function issueHref(id: string, from?: string | null): string {
  const f = safeFrom(from)
  return f ? `/pm/issues/${id}?from=${encodeURIComponent(f)}` : `/pm/issues/${id}`
}

/**
 * The current page as an origin — call from click handlers (it reads
 * window.location, so never during render/SSR). On an issue page the
 * page's OWN origin is forwarded (a palette hop from an issue keeps the
 * list it came from); null outside /pm, which makes issueHref() emit a
 * plain link.
 */
export function currentPmPath(): string | null {
  if (typeof window === 'undefined') return null
  const { pathname, search } = window.location
  if (/^\/pm\/issues\/[^/]+$/.test(pathname)) {
    return safeFrom(new URLSearchParams(search).get('from'))
  }
  return safeFrom(pathname + search)
}

export interface BackLabelCtx {
  /** Resolve a project id to its name (engine store or REST list). */
  projectName?: (projectId: string) => string | null | undefined
  /** The issue's team key — the label for the plain team list. */
  teamKey?: string | null
}

/** Human label for the Back button, from the origin path. */
export function backLabel(from: string | null, ctx: BackLabelCtx = {}): string {
  const [path = '', query = ''] = (from ?? '').split('?')
  const project = path.match(/^\/pm\/projects\/([^/]+)$/)
  if (project) return ctx.projectName?.(project[1]!) || 'Project'
  if (path === '/pm/projects') return 'Projects'
  if (path === '/pm/my') return 'My issues'
  if (path === '/pm/cycle') return 'Cycle'
  if (path === '/pm/triage') return 'Triage'
  if (path === '/pm/roadmap') return 'Roadmap'
  if (path === '/pm/timeline') return 'Timeline'
  if (path === '/pm/teams') return 'Teams'
  // The team list (or a deep link with no origin): "ENG issues" reads as a
  // place; a bare key does not. The board variant says so.
  const board = /(^|&)view=board(&|$)/.test(query)
  const base = ctx.teamKey ? `${ctx.teamKey} issues` : 'Issues'
  return board ? `${base} board` : base
}
