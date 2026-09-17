import type { QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'

// ─────────────────────────────────────────────────────────
// Round L — issue-open latency. The detail page renders its header and rail
// from the engine store instantly; the lazy bundle (description, comments,
// history, relations, files) is a react-query fetch. Warming that query on
// hover / focus of a row means the click lands on cached data — the page
// paints complete instead of with skeletons. One shared key so the page's
// own useQuery reuses the prefetched entry.
//
// Throttled: a sweep across a 200-row list must not fire 200 fetches. Each
// id waits HOVER_DELAY_MS (cancelled by mouseleave/blur), and at most
// MAX_IN_FLIGHT prefetches run at once — anything beyond that is simply
// skipped (the click's own query fetches it).
// ─────────────────────────────────────────────────────────

export const issueDetailQueryKey = (id: string) => ['pm', 'issue-detail', id] as const

const HOVER_DELAY_MS = 120
const MAX_IN_FLIGHT = 2
const STALE_MS = 30_000

const timers = new Map<string, ReturnType<typeof setTimeout>>()
let inFlight = 0

function fetchNow(qc: QueryClient, id: string): void {
  // Fresh in cache (or already fetching) → react-query returns at once.
  const state = qc.getQueryState(issueDetailQueryKey(id))
  if (state?.fetchStatus === 'fetching') return
  if (state?.dataUpdatedAt && Date.now() - state.dataUpdatedAt < STALE_MS) return
  if (inFlight >= MAX_IN_FLIGHT) return
  inFlight += 1
  void qc
    .prefetchQuery({
      queryKey: issueDetailQueryKey(id),
      queryFn: () => api.get(`/api/v1/pm/issues/${id}/detail`),
      staleTime: STALE_MS,
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = Math.max(0, inFlight - 1)
    })
}

/** Hover/focus warm-up for the detail payload — deferred, cancellable. */
export function prefetchIssueDetail(qc: QueryClient, id: string): void {
  if (timers.has(id)) return
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      fetchNow(qc, id)
    }, HOVER_DELAY_MS),
  )
}

/** The pointer left before the delay elapsed — never fetch. */
export function cancelIssuePrefetch(id: string): void {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

/** Spread onto a row/card: `{...issuePrefetchProps(qc, id)}`. */
export function issuePrefetchProps(qc: QueryClient, id: string) {
  const warm = () => prefetchIssueDetail(qc, id)
  const cool = () => cancelIssuePrefetch(id)
  return { onMouseEnter: warm, onMouseLeave: cool, onFocus: warm, onBlur: cool }
}
