'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  PmCompletionPrediction,
  PmInsightIssue,
  PmInsightState,
  PmInsightsConfig,
  PmProgressPoint,
} from '@flicks/shared/pm'
import { api } from '../client'

/**
 * Round M — the project rail's Insights card + Progress graph, REST mode.
 * `GET /pm/projects/:id/insights` ships the LIVE issue rows with their
 * lifecycle stamps plus the lookups; the pivot runs client-side with the
 * shared `@flicks/shared/pm` math, so flipping Measure/Slice/Segment never
 * re-fetches. In sync mode the cards read the FSE store instead and this
 * query stays disabled — nothing here may add a request to the page there.
 */

export interface PmProjectInsights {
  issues: PmInsightIssue[]
  states: PmInsightState[]
  labels: Record<string, { name: string; color?: string | null }>
  milestones: Record<string, string>
  users: Record<string, string>
  series: PmProgressPoint[]
  prediction: PmCompletionPrediction
  target_date: string | null
  insights_default: PmInsightsConfig | null
  generated_at: string
  /** True when the project holds more live issues than `issue_cap` — only the most recent ones are in `issues` (and in the series). */
  truncated: boolean
  issue_cap: number
}

export const projectInsightsKey = (projectId: string) => ['pm', 'project-insights', projectId] as const

export function useProjectInsights(projectId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: projectInsightsKey(projectId),
    queryFn: () => api.get<{ data: PmProjectInsights }>(`/api/v1/pm/projects/${projectId}/insights`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: (opts.enabled ?? true) && !!projectId,
  })
}

/** "Set default for everyone" — lead, or manager and above (the server decides). */
export function useSetInsightsDefault(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: PmInsightsConfig) =>
      api.post<{ data: { project_id: string; insights_default: PmInsightsConfig } }>(
        `/api/v1/pm/projects/${projectId}/insights-default`,
        cfg,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: projectInsightsKey(projectId) })
      void qc.invalidateQueries({ queryKey: ['pm', 'project-detail', projectId] })
    },
  })
}
