'use client'

import { useState } from 'react'
import { SettingsLayout } from '@/components/layout/SettingsLayout'
import { Btn, Icon, Modal, Pill, Toggle } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useWebhookEndpoints,
  useCreateWebhookEndpoint,
  useUpdateWebhookEndpoint,
  useDeleteWebhookEndpoint,
  useWebhookDeliveries,
  useRedriveDelivery,
  type WebhookEndpoint,
} from '@/lib/api/queries/use-developer'

// ─────────────────────────────────────────────────────────
// C19 — Settings → API & webhooks (§13): API keys (secret
// shown once), outbound webhook endpoints with the delivery
// log + per-delivery redrive. Owner/Admin only (API-enforced).
// ─────────────────────────────────────────────────────────

const SCOPES = ['crm:read', 'crm:write', 'directory:read', 'directory:write', 'webhooks:manage']
const COMMON_EVENTS = [
  'crm.lead.created', 'crm.lead.converted', 'crm.deal.created', 'crm.deal.stage_changed',
  'crm.deal.won', 'crm.deal.lost', 'crm.form.submitted', 'crm.email.replied',
  'invoice.created', 'invoice.paid', 'invoice.quote_accepted',
]

export default function DeveloperSettingsPage() {
  return (
    <SettingsLayout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 780 }}>
        <ApiKeysCard />
        <WebhooksCard />
      </div>
    </SettingsLayout>
  )
}

function ApiKeysCard() {
  const { data, isLoading } = useApiKeys()
  const revoke = useRevokeApiKey()
  const { toast } = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const rows = data?.data ?? []
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon.key size={15} style={{ color: 'var(--blue)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>API keys</div>
          <div className="t-mute" style={{ fontSize: 11 }}>Bearer keys for /api/public/v1 — 120 req/min each, scoped, revocable</div>
        </div>
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setCreateOpen(true)}>New key</Btn>
      </div>
      {isLoading ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={16} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No keys yet — create one to integrate your website, Zapier or scripts.</div>
      ) : (
        <table className="tbl">
          <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id}>
                <td style={{ fontWeight: 800 }}>{k.name}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{k.prefix}…</td>
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {k.scopes.map((s) => <Pill key={s}>{s}</Pill>)}
                  </div>
                </td>
                <td className="t-mute" style={{ fontSize: 11 }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                <td style={{ textAlign: 'right' }}>
                  <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={revoke.isPending}
                    onClick={() => revoke.mutate(k.id, { onSuccess: () => toast({ title: 'Key revoked' }) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {createOpen && <CreateKeyModal onClose={() => setCreateOpen(false)} />}
    </div>
  )
}

function CreateKeyModal({ onClose }: { onClose: () => void }) {
  const create = useCreateApiKey()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['crm:read'])
  const [revealed, setRevealed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = async () => {
    try {
      const res = await create.mutateAsync({ name, scopes })
      setRevealed(res.data.key)
    } catch (err) {
      toast({ title: 'Could not create key', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open onClose={onClose} width={520} title={revealed ? 'Copy your key now' : 'New API key'}
      sub={revealed ? 'This is the ONLY time the full key is shown' : 'Scoped bearer key for /api/public/v1'}
      footer={revealed ? <Btn kind="primary" onClick={onClose}>Done</Btn> : <>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!name.trim() || scopes.length === 0 || create.isPending} onClick={() => void submit()}>
          {create.isPending ? 'Creating…' : 'Create key'}
        </Btn>
      </>}>
      {revealed ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" readOnly value={revealed} style={{ flex: 1, height: 38, fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          <Btn kind={copied ? 'secondary' : 'primary'} size="sm" icon={copied ? <Icon.check size={13} /> : <Icon.copy size={13} />}
            onClick={() => { void navigator.clipboard.writeText(revealed); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}><div className="label">Name</div><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Website integration" style={{ width: '100%' }} /></div>
          <div className="label" style={{ marginBottom: 6 }}>Scopes</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SCOPES.map((s) => {
              const on = scopes.includes(s)
              return (
                <button key={s} onClick={() => setScopes((arr) => (on ? arr.filter((x) => x !== s) : [...arr, s]))}
                  style={{ padding: '6px 12px', borderRadius: 99, cursor: 'pointer', fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', background: on ? 'rgba(62,123,250,.14)' : 'var(--surf-1)', border: `1px solid ${on ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`, color: on ? 'var(--blue)' : 'var(--text-2)' }}>
                  {s}
                </button>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}

function WebhooksCard() {
  const { data, isLoading } = useWebhookEndpoints()
  const update = useUpdateWebhookEndpoint()
  const remove = useDeleteWebhookEndpoint()
  const { toast } = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [logFor, setLogFor] = useState<WebhookEndpoint | null>(null)
  const rows = data?.data ?? []
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon.zap size={15} style={{ color: 'var(--purple, #9b7bfa)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>Outbound webhooks</div>
          <div className="t-mute" style={{ fontSize: 11 }}>Signed (HMAC) POSTs on domain events · 5 retries with backoff · auto-disabled after 20 straight failures</div>
        </div>
        <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setCreateOpen(true)}>New endpoint</Btn>
      </div>
      {isLoading ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={16} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No endpoints yet — point one at your system and pick the events to receive.</div>
      ) : (
        <div>
          {rows.map((w, i) => (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{w.url}</div>
                <div className="t-mute" style={{ fontSize: 10.5 }}>
                  {w.events.length} events{w.disabled_reason ? ` · disabled: ${w.disabled_reason}` : w.consecutive_failures > 0 ? ` · ${w.consecutive_failures} recent failures` : ''}
                </div>
              </div>
              {!w.active && <Pill tone="coral">Disabled</Pill>}
              <Btn kind="secondary" size="sm" onClick={() => setLogFor(w)}>Delivery log</Btn>
              <Toggle on={w.active} onChange={(v: boolean) => update.mutate({ id: w.id, body: { active: v } })} />
              <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={remove.isPending}
                onClick={() => remove.mutate(w.id, { onSuccess: () => toast({ title: 'Endpoint deleted' }) })} />
            </div>
          ))}
        </div>
      )}
      {createOpen && <CreateEndpointModal onClose={() => setCreateOpen(false)} />}
      {logFor && <DeliveryLogModal endpoint={logFor} onClose={() => setLogFor(null)} />}
    </div>
  )
}

function CreateEndpointModal({ onClose }: { onClose: () => void }) {
  const create = useCreateWebhookEndpoint()
  const { toast } = useToast()
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>(['crm.deal.won'])
  const [secret, setSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = async () => {
    try {
      const res = await create.mutateAsync({ url, events })
      setSecret(res.data.secret)
    } catch (err) {
      toast({ title: 'Could not create endpoint', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open onClose={onClose} width={560} title={secret ? 'Copy the signing secret' : 'New webhook endpoint'}
      sub={secret ? 'Shown ONCE — verify X-Flicks-Signature with it' : 'We POST signed JSON for the events you pick'}
      footer={secret ? <Btn kind="primary" onClick={onClose}>Done</Btn> : <>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={!url.trim() || events.length === 0 || create.isPending} onClick={() => void submit()}>
          {create.isPending ? 'Creating…' : 'Create endpoint'}
        </Btn>
      </>}>
      {secret ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" readOnly value={secret} style={{ flex: 1, height: 38, fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          <Btn kind={copied ? 'secondary' : 'primary'} size="sm" icon={copied ? <Icon.check size={13} /> : <Icon.copy size={13} />}
            onClick={() => { void navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div className="label">Endpoint URL</div>
            <input autoFocus className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/flicks" style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          </div>
          <div className="label" style={{ marginBottom: 6 }}>Events</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {COMMON_EVENTS.map((ev) => {
              const on = events.includes(ev)
              return (
                <button key={ev} onClick={() => setEvents((arr) => (on ? arr.filter((x) => x !== ev) : [...arr, ev]))}
                  style={{ padding: '6px 12px', borderRadius: 99, cursor: 'pointer', fontSize: 10.5, fontWeight: 800, fontFamily: 'var(--font-mono)', background: on ? 'rgba(155,123,250,.14)' : 'var(--surf-1)', border: `1px solid ${on ? 'rgba(155,123,250,.45)' : 'var(--bord)'}`, color: on ? 'var(--purple, #9b7bfa)' : 'var(--text-2)' }}>
                  {ev}
                </button>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}

function DeliveryLogModal({ endpoint, onClose }: { endpoint: WebhookEndpoint; onClose: () => void }) {
  const { data, isLoading } = useWebhookDeliveries(endpoint.id)
  const redrive = useRedriveDelivery()
  const { toast } = useToast()
  const rows = data?.data ?? []
  return (
    <Modal open onClose={onClose} width={640} title="Delivery log" sub={endpoint.url}>
      {isLoading ? (
        <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div className="t-mute" style={{ fontSize: 12.5 }}>No deliveries yet — they appear when a subscribed event fires.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((d, i) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
              {d.status === 'success'
                ? <Icon.success size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
                : d.status === 'pending'
                  ? <Icon.refresh size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
                  : <Icon.warn size={14} style={{ color: 'var(--coral)', flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{d.event_name}</div>
                <div className="t-mute" style={{ fontSize: 10.5 }}>
                  {new Date(d.created_at).toLocaleString()} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                  {d.last_status_code ? ` · HTTP ${d.last_status_code}` : ''}{d.last_error ? ` · ${d.last_error.slice(0, 60)}` : ''}
                </div>
              </div>
              <Pill tone={d.status === 'success' ? 'green' : d.status === 'pending' ? '' : 'coral'}>{d.status}</Pill>
              {(d.status === 'failed' || d.status === 'exhausted') && (
                <Btn kind="secondary" size="sm" icon={<Icon.refresh size={12} />} disabled={redrive.isPending}
                  onClick={() => redrive.mutate({ endpointId: endpoint.id, deliveryId: d.id }, {
                    onSuccess: () => toast({ title: 'Delivery re-queued' }),
                    onError: (err) => toast({ title: 'Could not redrive', description: err instanceof Error ? err.message : undefined, variant: 'destructive' }),
                  })}>
                  Redrive
                </Btn>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
