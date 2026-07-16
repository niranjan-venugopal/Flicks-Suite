import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../client'

// Settings → API & webhooks (C19, PRD v5 §13). Owner/Admin only.

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  last_used_at: string | null
  created_at: string
}

export function useApiKeys() {
  return useQuery({ queryKey: ['dev', 'api-keys'], queryFn: () => api.get<{ data: ApiKeyRow[] }>('/api/v1/api-keys') })
}

export function useCreateApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[] }) =>
      api.post<{ data: ApiKeyRow & { key: string } }>('/api/v1/api-keys', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev', 'api-keys'] }),
  })
}

export function useRevokeApiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev', 'api-keys'] }),
  })
}

export interface WebhookEndpoint {
  id: string
  url: string
  events: string[]
  active: boolean
  consecutive_failures: number
  disabled_reason: string | null
  created_at: string
}

export interface WebhookDelivery {
  id: string
  event_name: string
  status: string
  attempts: number
  last_status_code: number | null
  last_error: string | null
  delivered_at: string | null
  created_at: string
}

export function useWebhookEndpoints() {
  return useQuery({ queryKey: ['dev', 'webhooks'], queryFn: () => api.get<{ data: WebhookEndpoint[] }>('/api/v1/webhooks/endpoints') })
}

export function useCreateWebhookEndpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { url: string; events: string[] }) =>
      api.post<{ data: WebhookEndpoint & { secret: string } }>('/api/v1/webhooks/endpoints', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev', 'webhooks'] }),
  })
}

export function useUpdateWebhookEndpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { url?: string; events?: string[]; active?: boolean } }) =>
      api.patch(`/api/v1/webhooks/endpoints/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev', 'webhooks'] }),
  })
}

export function useDeleteWebhookEndpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/webhooks/endpoints/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dev', 'webhooks'] }),
  })
}

export function useWebhookDeliveries(endpointId: string | null) {
  return useQuery({
    queryKey: ['dev', 'webhooks', endpointId, 'deliveries'],
    queryFn: () => api.get<{ data: WebhookDelivery[] }>(`/api/v1/webhooks/endpoints/${endpointId}/deliveries`),
    enabled: !!endpointId,
    refetchInterval: 30_000,
  })
}

export function useRedriveDelivery() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ endpointId, deliveryId }: { endpointId: string; deliveryId: string }) =>
      api.post(`/api/v1/webhooks/endpoints/${endpointId}/deliveries/${deliveryId}/redrive`, {}),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: ['dev', 'webhooks', v.endpointId, 'deliveries'] }),
  })
}
