'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useFamFeedback,
  useFamFeedbackUpdate,
  useFamNpsSummary,
  type FamFeedbackRow,
} from '@/lib/api/queries/use-feedback'

/**
 * D12 — FAM feedback inbox (table + filters + detail drawer with internal note
 * and status change) + D13 NPS tile (score, responses, P/P/D bar).
 */

const CAT_TONE: Record<string, string> = { bug: 'coral', idea: 'blue', question: 'purple', other: '' }
const ST_TONE: Record<string, string> = { new: 'blue', triaged: 'yellow', resolved: 'green', closed: '' }
const STATUSES = ['new', 'triaged', 'resolved', 'closed'] as const

function NpsTile() {
  const { data } = useFamNpsSummary()
  const d = data?.data
  const total = d?.total ?? 0
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
  return (
    <div className="card" style={{ maxWidth: 360, borderColor: 'rgba(155,123,250,.3)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div>
          <div className="t-caption" style={{ marginBottom: 6 }}>NPS · {d?.survey_key ?? 'beta_nps_v1'}</div>
          <div
            style={{
              fontSize: 34,
              fontWeight: 800,
              letterSpacing: '-0.04em',
              lineHeight: 1,
              color: (d?.score ?? 0) >= 0 ? 'var(--green)' : 'var(--coral)',
            }}
          >
            {(d?.score ?? 0) >= 0 ? '+' : ''}
            {d?.score ?? 0}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{total} responses</div>
          <div className="t-mute" style={{ fontSize: 10.5 }}>all time</div>
        </div>
      </div>
      <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', marginBottom: 12, background: 'var(--surf-2)' }}>
        <div style={{ width: `${pct(d?.promoters ?? 0)}%`, background: 'var(--green)' }} />
        <div style={{ width: `${pct(d?.passives ?? 0)}%`, background: 'var(--yellow)' }} />
        <div style={{ width: `${pct(d?.detractors ?? 0)}%`, background: 'var(--coral)' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          ['Promoters · 9–10', d?.promoters ?? 0, 'var(--green)'],
          ['Passives · 7–8', d?.passives ?? 0, 'var(--yellow)'],
          ['Detractors · 0–6', d?.detractors ?? 0, 'var(--coral)'],
        ].map(([l, v, c]) => (
          <div key={String(l)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, fontWeight: 700 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: String(c) }} />
            <span style={{ flex: 1, color: 'var(--text-2)' }}>{l}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function FamFeedbackPage() {
  const { toast } = useToast()
  const [catF, setCatF] = useState('')
  const [stF, setStF] = useState('')
  const [selected, setSelected] = useState<FamFeedbackRow | null>(null)
  const [note, setNote] = useState('')
  const list = useFamFeedback({ category: catF || undefined, status: stF || undefined })
  const update = useFamFeedbackUpdate()
  const rows = list.data?.data ?? []

  const openDrawer = (r: FamFeedbackRow) => {
    setSelected(r)
    setNote(r.internal_note ?? '')
  }

  const save = async (status?: string) => {
    if (!selected) return
    try {
      await update.mutateAsync({ id: selected.id, status, internal_note: note })
      toast({ title: 'Feedback updated' })
      setSelected(null)
    } catch (err) {
      toast({
        title: 'Could not update',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Feedback & NPS"
          sub="In-app submissions land here with tenant/user context · status changes are platform-audited"
        />

        <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 320px' : '1fr', gap: 16, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <NpsTile />

            {/* Filters */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ height: 34, width: 160, fontSize: 11.5 }} value={catF} onChange={(e) => setCatF(e.target.value)}>
                <option value="">All categories</option>
                <option value="bug">Bug</option>
                <option value="idea">Idea</option>
                <option value="question">Question</option>
                <option value="other">Other</option>
              </select>
              <select className="input" style={{ height: 34, width: 150, fontSize: 11.5 }} value={stF} onChange={(e) => setStF(e.target.value)}>
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
              <span className="t-caption" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
                {rows.length} submissions
              </span>
            </div>

            {/* Table */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {list.isLoading ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
                  <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Tenant · user</th>
                      <th>Category</th>
                      <th>Message</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'center' }}>Contact OK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} onClick={() => openDrawer(r)} style={{ cursor: 'pointer', background: selected?.id === r.id ? 'var(--surf-1)' : 'transparent' }}>
                        <td style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', whiteSpace: 'nowrap' }}>
                          {new Date(r.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Avatar name={r.tenant_name} size="sm" />
                            <div>
                              <div style={{ fontSize: 11.5, fontWeight: 800 }}>{r.tenant_name}</div>
                              <div style={{ fontSize: 10, color: 'var(--text-mute)', fontWeight: 600 }}>{r.user_name ?? '—'}</div>
                            </div>
                          </div>
                        </td>
                        <td><Pill tone={CAT_TONE[r.category] as never}>{r.category[0].toUpperCase() + r.category.slice(1)}</Pill></td>
                        <td style={{ maxWidth: 260 }}>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {r.message}
                          </div>
                        </td>
                        <td><Pill tone={ST_TONE[r.status] as never} dot>{r.status[0].toUpperCase() + r.status.slice(1)}</Pill></td>
                        <td style={{ textAlign: 'center' }}>
                          {r.contact_ok ? <Icon.mail size={14} style={{ color: 'var(--green)' }} /> : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12.5 }}>
                          No feedback yet — submissions from the in-app panel land here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Detail drawer */}
          {selected && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Pill tone={CAT_TONE[selected.category] as never}>{selected.category}</Pill>
                {selected.page_path && (
                  <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', marginLeft: 'auto' }}>
                    {selected.page_path}
                  </span>
                )}
              </div>
              <div style={{ padding: '13px 15px', borderRadius: 11, background: 'var(--surf-1)', border: '1px solid var(--bord)', fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.6 }}>
                {selected.message}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Avatar name={selected.user_name ?? '?'} size="sm" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 800 }}>{selected.user_name ?? 'Unknown'}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{selected.tenant_name}</div>
                </div>
                {selected.contact_ok && selected.user_email ? (
                  <Pill tone="green">{selected.user_email}</Pill>
                ) : (
                  <Pill>No contact consent</Pill>
                )}
              </div>
              <div>
                <div className="label">Internal note</div>
                <textarea
                  className="input"
                  style={{ height: 64, padding: 10, resize: 'none', fontSize: 12, width: '100%' }}
                  placeholder="Triage note for the team…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div>
                <div className="label">Status</div>
                <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }}>
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => save(s)}
                      style={{
                        flex: 1,
                        padding: '7px 0',
                        borderRadius: 6,
                        border: 'none',
                        cursor: 'pointer',
                        background: selected.status === s ? 'var(--surf-3)' : 'transparent',
                        color: selected.status === s ? '#fff' : 'var(--text-2)',
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      {s[0].toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Btn kind="ghost" size="sm" onClick={() => setSelected(null)}>Close</Btn>
                <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} onClick={() => save()}>
                  Save
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
