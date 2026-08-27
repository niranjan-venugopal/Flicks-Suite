'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Btn, Icon, Modal, Pill, SectionHead } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState, OwnerAv } from '@/components/crm/kit'
import { useToast } from '@/components/ui/use-toast'
import {
  useLeads,
  useCreateLead,
  useDeleteLead,
  useDiscardLead,
  useConvertLead,
  usePipelines,
  type Lead,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C6 — Leads inbox: triage rows from web forms, the API and
// manual adds. Convert = person + company + deal in ONE
// action (dupe-aware); discard keeps the row for analytics.
// ─────────────────────────────────────────────────────────

const TABS: Array<[string, string]> = [['new', 'New'], ['working', 'Working'], ['converted', 'Converted'], ['discarded', 'Discarded']]
const SRC_TONE = (s: string) => (s.startsWith('form:') ? 'blue' : s === 'api' ? 'green' : s === 'email_in' ? 'purple' : s === 'import' ? 'yellow' : '')

function ScoreBadge({ v }: { v: number }) {
  const c = v >= 30 ? 'var(--green)' : v >= 15 ? 'var(--yellow)' : 'var(--text-faint)'
  const bg = v >= 30 ? 'rgba(39,210,128,.14)' : v >= 15 ? 'rgba(254,216,0,.12)' : 'rgba(255,255,255,.06)'
  return (
    <span title="Lead score — calculated from the lead’s details and activity" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 30, height: 20, padding: '0 7px', borderRadius: 99, background: bg, color: c, fontSize: 10.5, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
      {v}
    </span>
  )
}

function ago(iso: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 60) return `${mins}m`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / 1440)}d`
}

export default function LeadsPage() {
  const [tab, setTab] = useState('new')
  const { data, isLoading } = useLeads(tab)
  const discard = useDiscardLead()
  const deleteLead = useDeleteLead()
  const { toast } = useToast()
  const [addOpen, setAddOpen] = useState(false)
  const [convertFor, setConvertFor] = useState<Lead | null>(null)
  const [deleting, setDeleting] = useState<Lead | null>(null)
  const rows = data?.data ?? []
  const counts = data?.counts ?? {}

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 1060, margin: '0 auto' }}>
      <SectionHead
        title="Leads"
        sub="Web forms, API and manual adds land here — triage fast, convert or discard."
        right={<Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => setAddOpen(true)}>Add lead</Btn>}
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }}>
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: '7px 13px', borderRadius: 6, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>
              {l}
              {(counts[k] ?? 0) > 0 && <span style={{ marginLeft: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: k === 'new' ? 'var(--coral)' : 'var(--text-mute)' }}>{counts[k]}</span>}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span className="t-caption">assignment: round-robin · skips Out-of-office reps</span>
      </div>

      {isLoading ? (
        <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon.inbox size={22} />}
          line="Leads land here from web forms, the API and manual adds — triage fast, convert or discard."
          cta="Add lead"
          onCta={() => setAddOpen(true)}
        />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="tbl">
            <thead><tr><th>Lead</th><th>Score</th><th>Source</th><th>Owner</th><th>Age</th><th style={{ textAlign: 'right' }}>Quick actions</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <OwnerAv name={`${l.first_name} ${l.last_name ?? ''}`} size={26} />
                      <div>
                        <div style={{ fontWeight: 800 }}>
                          {l.first_name} {l.last_name ?? ''}
                          {l.company_name && <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}> @ {l.company_name}</span>}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-mute)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{l.email}{l.phone ? ` · ${l.phone}` : ''}</div>
                      </div>
                      {l.dupe_person && <Pill tone="yellow" icon={<Icon.warn size={10} />}>possible duplicate</Pill>}
                    </div>
                  </td>
                  <td><ScoreBadge v={l.score} /></td>
                  <td><Pill tone={SRC_TONE(l.source)}>{l.source}</Pill></td>
                  <td>
                    {l.owner_name
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><OwnerAv name={l.owner_name} size={20} /><span style={{ fontSize: 11.5, fontWeight: 700 }}>{l.owner_name.split(' ')[0]}</span></span>
                      : <span className="t-caption">unassigned</span>}
                  </td>
                  <td className="t-mute" style={{ fontSize: 11.5 }}>{ago(l.created_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(l.status === 'new' || l.status === 'working') ? (
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <Btn kind="primary" size="sm" icon={<Icon.check size={12} />} onClick={() => setConvertFor(l)}>Convert</Btn>
                        <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} disabled={discard.isPending}
                          onClick={() => discard.mutate(l.id, { onSuccess: () => toast({ title: 'Lead discarded' }) })}>Discard</Btn>
                        <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={deleteLead.isPending}
                          onClick={() => setDeleting(l)} />
                      </div>
                    ) : l.status === 'converted' && l.converted_deal_id ? (
                      <Link href={`/crm/deals/${l.converted_deal_id}`} style={{ color: 'var(--blue)', fontSize: 11.5, fontWeight: 800, textDecoration: 'none' }}>View deal →</Link>
                    ) : (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span className="t-caption">kept for source analytics</span>
                        <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} disabled={deleteLead.isPending}
                          onClick={() => setDeleting(l)} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="t-caption" style={{ marginTop: 10 }}>A lead is a lightweight triage row — converting creates or links the company and contact, plus a deal. Discard needs no reason.</div>

      {addOpen && <AddLeadModal onClose={() => setAddOpen(false)} />}
      {convertFor && <ConvertModal lead={convertFor} onClose={() => setConvertFor(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete lead"
        danger
        body={
          deleting?.status === 'new' || deleting?.status === 'working'
            ? 'Delete this lead? This removes it from every view.'
            : 'Delete this lead? It will no longer count in source analytics.'
        }
        confirmLabel="Delete lead"
        loading={deleteLead.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => deleting && deleteLead.mutate(deleting.id, {
          onSuccess: () => { toast({ title: 'Lead deleted' }); setDeleting(null) },
        })}
      />
    </div>
  )
}

function AddLeadModal({ onClose }: { onClose: () => void }) {
  const create = useCreateLead()
  const { toast } = useToast()
  const [form, setForm] = useState({ first_name: '', last_name: '', company_name: '', email: '', phone: '', note: '' })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = async () => {
    try {
      await create.mutateAsync({ ...form, email: form.email || undefined })
      toast({ title: 'Lead added' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not add lead', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  return (
    <Modal open onClose={onClose} width={520} title="Add lead" sub="Manual capture — forms, BCC and the API add the rest automatically"
      footer={<>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={(!form.first_name.trim() && !form.email.trim()) || create.isPending} onClick={() => void submit()}>
          {create.isPending ? 'Adding…' : 'Add lead'}
        </Btn>
      </>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div><div className="label">First name</div><input autoFocus className="input" value={form.first_name} onChange={set('first_name')} style={{ width: '100%' }} /></div>
        <div><div className="label">Last name</div><input className="input" value={form.last_name} onChange={set('last_name')} style={{ width: '100%' }} /></div>
        <div><div className="label">Email</div><input className="input" type="email" value={form.email} onChange={set('email')} style={{ width: '100%' }} /></div>
        <div><div className="label">Phone</div><input className="input" value={form.phone} onChange={set('phone')} style={{ width: '100%' }} /></div>
        <div style={{ gridColumn: '1/-1' }}><div className="label">Company</div><input className="input" value={form.company_name} onChange={set('company_name')} placeholder="Optional" style={{ width: '100%' }} /></div>
        <div style={{ gridColumn: '1/-1' }}><div className="label">Note</div><textarea className="input" value={form.note} onChange={set('note')} style={{ width: '100%', height: 70, padding: 10, resize: 'vertical' }} /></div>
      </div>
    </Modal>
  )
}

function ConvertModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const convert = useConvertLead()
  const pipelines = usePipelines()
  const { toast } = useToast()
  const [linkExisting, setLinkExisting] = useState(true)
  const [done, setDone] = useState<{ deal_id: string } | null>(null)
  const [personName, setPersonName] = useState(`${lead.first_name} ${lead.last_name ?? ''}`.trim())
  const [companyName, setCompanyName] = useState(lead.company_name ?? '')
  const [pipelineId, setPipelineId] = useState('')
  const [stageId, setStageId] = useState('')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('')

  const pl = useMemo(() => {
    const list = pipelines.data?.data ?? []
    return list.find((p) => p.id === pipelineId) ?? list.find((p) => p.is_default) ?? list[0]
  }, [pipelines.data, pipelineId])
  const openStages = (pl?.stages ?? []).filter((s) => s.stage_type === 'open').sort((a, b) => a.display_order - b.display_order)

  const submit = async () => {
    try {
      const res = await convert.mutateAsync({
        id: lead.id,
        body: {
          link_person_id: linkExisting && lead.dupe_person ? lead.dupe_person.id : undefined,
          person_name: personName || undefined,
          company_name: companyName || undefined,
          pipeline_id: pl?.id,
          stage_id: stageId || undefined,
          value_amount: value ? parseFloat(value) : undefined,
          currency: currency || undefined,
        },
      })
      setDone({ deal_id: res.data.deal_id })
    } catch (err) {
      toast({ title: 'Could not convert', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <Modal open onClose={onClose} width={560}
      title={done ? undefined : 'Convert lead'}
      sub={done ? undefined : 'One action: person + company + deal — no duplicate lead object left behind'}
      footer={done ? undefined : <>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.check size={14} />} disabled={convert.isPending} onClick={() => void submit()}>
          {convert.isPending ? 'Converting…' : 'Convert'}
        </Btn>
      </>}>
      {done ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '14px 0', textAlign: 'center' }}>
          <div style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(39,210,128,.14)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon.check size={22} /></div>
          <div style={{ fontSize: 14.5, fontWeight: 800 }}>Lead converted</div>
          <div className="t-mute" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {personName} {lead.dupe_person && linkExisting ? 'linked to the existing record' : 'created'} · deal opened in {openStages[0]?.name ?? 'the pipeline'}
          </div>
          <Link href={`/crm/deals/${done.deal_id}`}><Btn kind="primary" size="sm" icon={<Icon.arrow size={13} />} onClick={onClose}>Open the deal</Btn></Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {lead.dupe_person && (
            <div style={{ padding: '12px 14px', borderRadius: 11, background: 'rgba(254,216,0,.07)', border: '1px solid rgba(254,216,0,.3)' }}>
              <div style={{ display: 'flex', gap: 9, marginBottom: 10 }}>
                <Icon.warn size={14} style={{ color: 'var(--yellow)', flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
                  Looks like <b style={{ color: '#fff' }}>{lead.dupe_person.display_name ?? lead.dupe_person.email}</b> already exists in your directory — link instead of creating a duplicate?
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setLinkExisting(true)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', borderRadius: 9, background: linkExisting ? 'rgba(62,123,250,.1)' : 'var(--surf-1)', border: `1px solid ${linkExisting ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`, cursor: 'pointer', textAlign: 'left' }}>
                  <OwnerAv name={lead.dupe_person.display_name ?? '?'} size={26} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#fff' }}>Link to {lead.dupe_person.display_name ?? lead.dupe_person.email}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-mute)', fontWeight: 600 }}>{lead.dupe_person.email} · exact email match</div>
                  </div>
                  {linkExisting && <Icon.check size={14} style={{ marginLeft: 'auto', color: 'var(--blue)' }} />}
                </button>
                <button onClick={() => setLinkExisting(false)} style={{ padding: '9px 13px', borderRadius: 9, background: !linkExisting ? 'rgba(62,123,250,.1)' : 'var(--surf-1)', border: `1px solid ${!linkExisting ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`, cursor: 'pointer', fontSize: 12, fontWeight: 800, color: !linkExisting ? '#fff' : 'var(--text-2)' }}>
                  Create new
                </button>
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><div className="label">Person</div><input className="input" value={personName} onChange={(e) => setPersonName(e.target.value)} style={{ height: 38, width: '100%' }} /></div>
            <div><div className="label">Company</div><input className="input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Optional" style={{ height: 38, width: '100%' }} /></div>
            <div>
              <div className="label">Pipeline</div>
              <select className="input" value={pl?.id ?? ''} onChange={(e) => { setPipelineId(e.target.value); setStageId('') }} style={{ height: 38, width: '100%' }}>
                {(pipelines.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <div className="label">Stage</div>
              <select className="input" value={stageId || openStages[0]?.id || ''} onChange={(e) => setStageId(e.target.value)} style={{ height: 38, width: '100%' }}>
                {openStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <div className="label">Deal value <span style={{ color: 'var(--text-faint)' }}>· optional</span></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input t-num" placeholder="0" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} style={{ height: 38, flex: 1 }} />
                <input className="input" placeholder="INR" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} style={{ height: 38, width: 88 }} />
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
