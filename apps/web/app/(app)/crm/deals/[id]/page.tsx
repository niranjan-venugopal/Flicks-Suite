'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { TagChip, OwnerAv, CurVal, fmtCur } from '@/components/crm/kit'
import { WonDialog, LostDialog } from '@/components/crm/deal-dialogs'
import { ACT_META, ScheduleActivityModal, useCompleteWithNext, dueLabel } from '@/components/crm/activity-widgets'
import {
  useDeal,
  usePipelines,
  useLostReasons,
  useTags,
  useCreateTag,
  useAttachTag,
  useDetachTag,
  useMoveDeal,
  useReopenDeal,
  useUpdateDeal,
  useCreateInvoiceFromDeal,
  useCreateQuoteFromDeal,
  useAddDealProduct,
  useRemoveDealProduct,
  useAddDealPerson,
  useRemoveDealPerson,
  useContacts,
  useCustomFields,
  useDealActivities,
  type DealDetail,
  type Activity,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C3 — Deal detail (scr-deal.jsx, ported to live data)
// header + stage stepper + tabs (timeline · products · emails ·
// files · people · details) + linked-doc chips + Won/Lost dialogs
// ─────────────────────────────────────────────────────────

type TabKey = 'timeline' | 'products' | 'emails' | 'files' | 'people' | 'details'
const TABS: Array<[TabKey, string]> = [
  ['timeline', 'Timeline'], ['products', 'Products'], ['emails', 'Emails'],
  ['files', 'Files'], ['people', 'People'], ['details', 'Details'],
]

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { data, isLoading, error } = useDeal(id)
  const pipelines = usePipelines()
  const lostReasons = useLostReasons()
  const move = useMoveDeal()
  const reopen = useReopenDeal()
  const createInvoice = useCreateInvoiceFromDeal()
  const createQuote = useCreateQuoteFromDeal()

  const [tab, setTab] = useState<TabKey>('timeline')
  const [wonOpen, setWonOpen] = useState(false)
  const [lostOpen, setLostOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const dealActivities = useDealActivities(id)
  const completeLoop = useCompleteWithNext(id)

  const d = data?.data
  const pipeline = pipelines.data?.data.find((p) => p.id === d?.pipeline_id)
  const stages = useMemo(() => (pipeline?.stages ?? []).slice().sort((a, b) => a.display_order - b.display_order), [pipeline])
  const openStages = stages.filter((s) => s.stage_type === 'open')
  const wonStage = stages.find((s) => s.stage_type === 'won')
  const lostStage = stages.find((s) => s.stage_type === 'lost')
  const currentStage = stages.find((s) => s.id === d?.stage_id)

  if (isLoading) {
    return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }
  if (error || !d) {
    return (
      <div style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Deal not found</div>
        <Link href="/crm/deals"><Btn kind="secondary" size="sm">Back to deals</Btn></Link>
      </div>
    )
  }

  const base = d.base_currency
  const doMove = async (stageId: string, opts?: { lost_reason_id?: string; lost_reason_note?: string }) => {
    try {
      await move.mutateAsync({ id, body: { stage_id: stageId, ...opts } })
      return true
    } catch (err) {
      toast({ title: 'Could not move', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
      return false
    }
  }

  const onCreateInvoice = async () => {
    try {
      await createInvoice.mutateAsync(id)
      toast({ title: 'Draft invoice created', description: 'Opening Invoicing → Invoices to review and send.' })
      router.push('/invoicing/invoices')
    } catch (err) {
      toast({ title: 'Could not create invoice', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  const onCreateQuote = async () => {
    try {
      await createQuote.mutateAsync(id)
      toast({ title: 'Draft quote created', description: 'Opening Invoicing → Quotes to review and send.' })
      router.push('/invoicing/quotes')
    } catch (err) {
      toast({ title: 'Could not create quote', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const stageIdx = stages.findIndex((s) => s.id === d.stage_id)
  const dayInStage = d.stage_history[0] ? Math.max(0, Math.floor((Date.now() - new Date(d.stage_history[0].changed_at).getTime()) / 86_400_000)) : 0

  return (
    <div style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 24px 64px' }}>
      <Link href="/crm/deals" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 9, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 800, marginBottom: 16 }}>
        <Icon.arrowL size={14} /> Board
      </Link>

      {/* Header card */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6, flexWrap: 'wrap' }}>
              <span className="t-h2" style={{ fontSize: 20 }}>{d.title}</span>
              <DealTags deal={d} />
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <CurVal v={parseFloat(d.value_amount)} cur={d.currency} base={base} baseValue={parseFloat(d.value_base_amount)} size={17} />
              {d.company && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
                  <Icon.building size={13} style={{ color: 'var(--text-mute)' }} />{d.company.name}
                </span>
              )}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
                <Icon.cal size={13} style={{ color: 'var(--text-mute)' }} />Close {d.expected_close_date ?? '—'}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
                <OwnerAv name={d.owner_name ?? null} size={20} /> {d.owner_name ?? '—'}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {d.status === 'open' ? (
              <>
                <Btn kind="secondary" size="sm" icon={<Icon.doc size={13} />} onClick={() => void onCreateQuote()} disabled={createQuote.isPending}>Create quote</Btn>
                <Btn kind="secondary" size="sm" icon={<Icon.receipt size={13} />} onClick={() => void onCreateInvoice()} disabled={createInvoice.isPending}>Create invoice</Btn>
                {wonStage && <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} onClick={async () => { if (await doMove(wonStage.id)) setWonOpen(true) }}>Won</Btn>}
                {lostStage && <Btn kind="danger" size="sm" icon={<Icon.x size={13} />} onClick={() => setLostOpen(true)}>Lost</Btn>}
              </>
            ) : (
              <>
                <Pill tone={d.status === 'won' ? 'green' : 'coral'}>{d.status === 'won' ? '🏆 Won' : 'Lost'}</Pill>
                <Btn kind="secondary" size="sm" icon={<Icon.refresh size={13} />} onClick={() => reopen.mutate(id)} disabled={reopen.isPending} title="Manager and above">
                  Reopen
                </Btn>
              </>
            )}
          </div>
        </div>

        {/* Stage stepper */}
        <div style={{ margin: '16px 0 6px' }}>
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            {stages.map((s, i) => (
              <div key={s.id} title={`${s.name} · ${s.win_probability}%${s.stage_type !== 'open' ? '' : ' — click to move'}`}
                onClick={() => { if (s.stage_type === 'open' && d.status === 'open' && s.id !== d.stage_id) void doMove(s.id) }}
                style={{
                  height: 8, flex: 1, minWidth: 34,
                  borderRadius: i === 0 ? '99px 2px 2px 99px' : i === stages.length - 1 ? '2px 99px 99px 2px' : 2,
                  background: i < stageIdx ? 'rgba(62,123,250,.45)' : i === stageIdx ? (d.status === 'won' ? 'var(--green)' : d.status === 'lost' ? 'var(--coral)' : 'var(--blue)') : 'var(--surf-2)',
                  border: `1px solid ${i <= stageIdx ? 'transparent' : 'var(--bord)'}`,
                  cursor: s.stage_type === 'open' && d.status === 'open' ? 'pointer' : 'default',
                }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <span className="t-caption">{openStages[0]?.name ?? ''}</span>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: d.status === 'won' ? 'var(--green)' : d.status === 'lost' ? 'var(--coral)' : 'var(--blue)' }}>
              {currentStage ? `${currentStage.name} · ${currentStage.win_probability}% · day ${dayInStage}` : ''}
            </span>
            <span className="t-caption">{wonStage?.name ?? 'Won'}</span>
          </div>
        </div>

        {/* Linked billing documents (§4.4 echo) */}
        {(d.linked_invoice || d.linked_quote) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {d.linked_invoice && (
              <Link href="/invoicing/invoices" style={{ textDecoration: 'none' }}>
                <Pill tone={d.linked_invoice.status === 'PAID' ? 'green' : 'blue'} icon={<Icon.receipt size={11} />}>
                  {d.linked_invoice.number} · {d.linked_invoice.status === 'PAID' ? `Paid ${fmtCur(parseFloat(d.linked_invoice.total), d.currency)}` : d.linked_invoice.status}
                </Pill>
              </Link>
            )}
            {d.linked_quote && (
              <Link href="/invoicing/quotes" style={{ textDecoration: 'none' }}>
                <Pill tone={d.linked_quote.status === 'ACCEPTED' ? 'green' : 'blue'} icon={<Icon.doc size={11} />}>
                  {d.linked_quote.number} · {d.linked_quote.status}
                </Pill>
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Next-activity banner — the §6 follow-up loop (doctrine 4c) */}
      {d.status === 'open' && (() => {
        const nextAct = (dealActivities.data?.data ?? []).find((a) => !a.completed_at && a.due_at)
        return nextAct ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 15px', borderRadius: 11, marginBottom: 14, background: 'rgba(62,123,250,.08)', border: '1px solid rgba(62,123,250,.3)' }}>
            <Icon.cal size={15} style={{ color: 'var(--blue)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>
              Next: <b>{nextAct.subject}</b> · {dueLabel(nextAct).text}
              {nextAct.assignee_name ? ` with ${nextAct.assignee_name}` : ''}
            </span>
            <Btn kind="ghost" size="sm" onClick={() => setScheduleOpen(true)}>Schedule more</Btn>
            <Btn kind="secondary" size="sm" icon={<Icon.check size={13} />} onClick={() => completeLoop.start(nextAct)} disabled={completeLoop.busy}>Complete</Btn>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 15px', borderRadius: 11, marginBottom: 14, background: 'rgba(248,120,107,.07)', border: '1px solid rgba(248,120,107,.3)' }}>
            <Icon.warn size={15} style={{ color: 'var(--coral)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>No next activity — schedule the next step so this deal never goes quiet.</span>
            <Btn kind="secondary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setScheduleOpen(true)}>Schedule next</Btn>
          </div>
        )
      })()}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 10, marginBottom: 16, width: 'fit-content' }}>
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>
            {l}
            {k === 'products' && d.products.length > 0 && <span style={{ marginLeft: 5, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{d.products.length}</span>}
            {k === 'people' && d.people.length > 0 && <span style={{ marginLeft: 5, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{d.people.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'timeline' && <TimelineTab deal={d} stages={stages} activities={dealActivities.data?.data ?? []} onComplete={completeLoop.start} onLog={() => setScheduleOpen(true)} />}
      {tab === 'products' && <ProductsTab deal={d} onCreateInvoice={() => void onCreateInvoice()} onCreateQuote={() => void onCreateQuote()} busy={createInvoice.isPending || createQuote.isPending} />}
      {tab === 'emails' && (
        <div className="card" style={{ padding: '36px 24px', textAlign: 'center' }}>
          <Icon.mail size={22} style={{ color: 'var(--text-mute)', marginBottom: 8 }} />
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)' }}>Email on deals arrives with the Email phase</div>
          <div className="t-caption" style={{ marginTop: 4 }}>Compose, tracking, sequences and the BCC dropbox are next up (§7)</div>
        </div>
      )}
      {tab === 'files' && (
        <div className="card">
          <div style={{ border: '1.5px dashed var(--bord-2)', borderRadius: 12, padding: 22, textAlign: 'center', color: 'var(--text-mute)' }}>
            <Icon.upload size={20} style={{ marginBottom: 6 }} />
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>File attachments arrive with the Activities phase</div>
            <div className="t-caption" style={{ marginTop: 4 }}>Up to 25 MB · images, docs, PDFs · no SVG (upload pipeline rule)</div>
          </div>
        </div>
      )}
      {tab === 'people' && <PeopleTab deal={d} />}
      {tab === 'details' && <DetailsTab deal={d} pipelineName={pipeline?.name} stageName={currentStage?.name} stageProb={currentStage?.win_probability} />}

      <WonDialog
        open={wonOpen}
        onClose={() => setWonOpen(false)}
        deal={{
          title: d.title, companyName: d.company?.name ?? null,
          value: parseFloat(d.value_amount), currency: d.currency, base,
          baseValue: parseFloat(d.value_base_amount),
          productCount: d.products.length, customerLinked: !!d.invoice_id || !!d.quote_id,
        }}
        busy={createInvoice.isPending || createQuote.isPending}
        onCreateInvoice={() => { setWonOpen(false); void onCreateInvoice() }}
        onCreateQuote={() => { setWonOpen(false); void onCreateQuote() }}
      />
      {lostStage && (
        <LostDialog
          open={lostOpen}
          onClose={() => setLostOpen(false)}
          reasons={lostReasons.data?.data ?? []}
          busy={move.isPending}
          onConfirm={async (reasonId, note) => {
            const ok = await doMove(lostStage.id, { lost_reason_id: reasonId, ...(note ? { lost_reason_note: note } : {}) })
            if (ok) setLostOpen(false)
          }}
        />
      )}
      <ScheduleActivityModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} dealId={id} />
      {completeLoop.ui}
    </div>
  )
}

// ── Header tag chips + add-tag picker (§19.1) ──
function DealTags({ deal }: { deal: DealDetail }) {
  const tags = useTags()
  const createTag = useCreateTag()
  const attach = useAttachTag()
  const detach = useDetachTag()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const attached = new Set(deal.tags.map((t) => t.id))
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', position: 'relative' }}>
      {deal.tags.map((t) => (
        <TagChip key={t.id} tag={t} onRemove={() => detach.mutate({ type: 'deal', id: deal.id, tagId: t.id })} />
      ))}
      <button onClick={() => setOpen((o) => !o)} title="Add tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, background: 'transparent', border: '1px dashed var(--bord-2)', color: 'var(--text-faint)', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>
        <Icon.tag size={10} /> tag
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 70, width: 220, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 8, boxShadow: '0 16px 40px rgba(0,0,0,.5)' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input autoFocus className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New tag…" style={{ height: 28, fontSize: 11, flex: 1 }}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && label.trim()) {
                  const t = await createTag.mutateAsync({ label: label.trim() })
                  await attach.mutateAsync({ type: 'deal', id: deal.id, tagId: t.data.id })
                  setLabel(''); setOpen(false)
                }
                if (e.key === 'Escape') setOpen(false)
              }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflowY: 'auto' }}>
            {(tags.data?.data ?? []).filter((t) => !attached.has(t.id)).map((t) => (
              <button key={t.id} onClick={() => { attach.mutate({ type: 'deal', id: deal.id, tagId: t.id }); setOpen(false) }}
                style={{ display: 'flex', alignItems: 'center', padding: '5px 6px', borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <TagChip tag={t} small />
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

// ── Timeline tab — open activities + stage history + billing echoes ──
function TimelineTab({ deal, stages, activities, onComplete, onLog }: {
  deal: DealDetail
  stages: Array<{ id: string; name: string; stage_type: string }>
  activities: Activity[]
  onComplete: (a: Activity) => void
  onLog: () => void
}) {
  const stageName = (sid: string | null) => stages.find((s) => s.id === sid)?.name ?? '—'
  const open = activities.filter((a) => !a.completed_at)
  type Entry = { icon: keyof typeof Icon; title: string; meta: string; when: string; suite?: boolean; act?: boolean; color?: string }
  const entries: Entry[] = []
  for (const a of activities.filter((x) => x.completed_at)) {
    const M = ACT_META[a.type]
    entries.push({
      icon: M.icon, color: M.color, act: true,
      title: a.type === 'note' ? a.subject : `${M.label} completed — ${a.subject}`,
      meta: [a.outcome?.replace(/_/g, ' '), a.body].filter(Boolean).join(' · ') || (a.assignee_name ?? ''),
      when: new Date(a.completed_at!).toLocaleString(),
    })
  }
  if (deal.linked_invoice) entries.push({ icon: 'receipt', title: `Invoice ${deal.linked_invoice.number} created from this deal`, meta: `${deal.linked_invoice.status} · ${fmtCur(parseFloat(deal.linked_invoice.total), deal.currency)}`, when: new Date(deal.linked_invoice.created_at).toLocaleDateString(), suite: true })
  if (deal.linked_quote) entries.push({ icon: 'doc', title: `Quote ${deal.linked_quote.number} created from this deal`, meta: `${deal.linked_quote.status}`, when: new Date(deal.linked_quote.created_at).toLocaleDateString(), suite: true })
  for (const h of deal.stage_history) {
    entries.push(
      h.from_stage_id == null
        ? { icon: 'plus', title: 'Deal created', meta: `Entered ${stageName(h.to_stage_id)}`, when: new Date(h.changed_at).toLocaleString() }
        : { icon: 'switchH', title: `Moved to ${stageName(h.to_stage_id)}`, meta: `From ${stageName(h.from_stage_id)}${h.seconds_in_previous_stage != null ? ` · ${Math.max(1, Math.round(h.seconds_in_previous_stage / 86_400))}d in stage` : ''}`, when: new Date(h.changed_at).toLocaleString() },
    )
  }
  return (
    <>
      {open.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
          <div className="t-caption" style={{ padding: '12px 20px 4px' }}>Scheduled</div>
          {open.map((a, i) => {
            const M = ACT_META[a.type]
            const Ic = Icon[M.icon]
            const due = dueLabel(a)
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '11px 20px', borderBottom: i < open.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: `${M.color}20`, color: M.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic size={14} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{a.subject}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: due.overdue ? 'var(--coral)' : 'var(--text-mute)', marginTop: 2 }}>
                    {due.text}{a.assignee_name ? ` · ${a.assignee_name}` : ''}{due.overdue ? ' · overdue' : ''}
                  </div>
                </div>
                <Btn kind="secondary" size="sm" icon={<Icon.check size={13} />} onClick={() => onComplete(a)}>Complete</Btn>
              </div>
            )
          })}
        </div>
      )}
      <div className="card" style={{ padding: '6px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px 4px' }}>
          <span className="t-caption" style={{ flex: 1 }}>History</span>
          <Btn kind="ghost" size="sm" icon={<Icon.plus size={12} />} onClick={onLog}>Schedule activity</Btn>
        </div>
        {entries.length === 0 && <div className="t-mute" style={{ padding: 20, fontSize: 12.5 }}>No timeline entries yet.</div>}
        {entries.map((t, i) => {
          const Ic = Icon[t.icon]
          return (
            <div key={i} style={{ display: 'flex', gap: 13, padding: '13px 20px', borderBottom: i < entries.length - 1 ? '1px solid var(--bord)' : 'none' }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: t.suite ? 'rgba(39,210,128,.13)' : t.act ? `${t.color}20` : 'var(--surf-2)', color: t.suite ? 'var(--green)' : t.act ? t.color : 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Ic size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
                  {t.title}{t.suite && <Pill tone="green" style={{ marginLeft: 8 }}>suite event</Pill>}
                </div>
                {t.meta && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>{t.meta}</div>}
              </div>
              <span className="t-caption" style={{ whiteSpace: 'nowrap' }}>{t.when}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Products tab (§4.4 — lines behind invoice/quote; value auto-sums) ──
function ProductsTab({ deal, onCreateInvoice, onCreateQuote, busy }: { deal: DealDetail; onCreateInvoice: () => void; onCreateQuote: () => void; busy: boolean }) {
  const addProduct = useAddDealProduct()
  const removeProduct = useRemoveDealProduct()
  const { toast } = useToast()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', quantity: '1', unit_price: '', discount_pct: '' })
  const total = deal.products.reduce((s, p) => s + parseFloat(p.line_total), 0)

  const submit = async () => {
    try {
      await addProduct.mutateAsync({ dealId: deal.id, body: { name: form.name, quantity: parseFloat(form.quantity) || 1, unit_price: parseFloat(form.unit_price) || 0, discount_pct: form.discount_pct ? parseFloat(form.discount_pct) : 0 } })
      setForm({ name: '', quantity: '1', unit_price: '', discount_pct: '' })
      setAdding(false)
    } catch (err) {
      toast({ title: 'Could not add product', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="t-h3" style={{ flex: 1 }}>Products</div>
        <Btn kind="ghost" size="sm" icon={<Icon.plus size={13} />} onClick={() => setAdding((a) => !a)}>Add product</Btn>
      </div>
      {adding && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--bord)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 2, minWidth: 160 }}><div className="label">Item</div><input autoFocus className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Implementation package" style={{ height: 32, fontSize: 12, width: '100%' }} /></div>
          <div style={{ width: 70 }}><div className="label">Qty</div><input className="input t-num" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} style={{ height: 32, fontSize: 12, width: '100%' }} /></div>
          <div style={{ width: 110 }}><div className="label">Unit ({deal.currency})</div><input className="input t-num" value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} placeholder="1000" style={{ height: 32, fontSize: 12, width: '100%' }} /></div>
          <div style={{ width: 80 }}><div className="label">Disc %</div><input className="input t-num" value={form.discount_pct} onChange={(e) => setForm({ ...form, discount_pct: e.target.value })} placeholder="0" style={{ height: 32, fontSize: 12, width: '100%' }} /></div>
          <Btn kind="primary" size="sm" icon={<Icon.check size={12} />} onClick={() => void submit()} disabled={!form.name.trim() || !form.unit_price || addProduct.isPending}>Add</Btn>
        </div>
      )}
      {deal.products.length > 0 ? (
        <table className="tbl">
          <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Unit</th><th style={{ textAlign: 'right' }}>Disc</th><th style={{ textAlign: 'right' }}>Line total</th><th /></tr></thead>
          <tbody>
            {deal.products.map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 700 }}>
                  {p.name} {p.item_id ? <Pill style={{ marginLeft: 6 }}>catalogue</Pill> : <Pill tone="yellow" style={{ marginLeft: 6 }}>free-text</Pill>}
                </td>
                <td className="t-num" style={{ textAlign: 'right' }}>{parseFloat(p.quantity)}</td>
                <td className="t-num" style={{ textAlign: 'right' }}>{fmtCur(parseFloat(p.unit_price), p.currency)}</td>
                <td className="t-num" style={{ textAlign: 'right' }}>{p.discount_pct && parseFloat(p.discount_pct) > 0 ? `${parseFloat(p.discount_pct)}%` : '—'}</td>
                <td className="t-num" style={{ textAlign: 'right', fontWeight: 800 }}>{fmtCur(parseFloat(p.line_total), p.currency)}</td>
                <td style={{ textAlign: 'right', width: 40 }}>
                  <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} onClick={() => removeProduct.mutate({ dealId: deal.id, productId: p.id })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="t-mute" style={{ padding: '18px', fontSize: 12.5 }}>No products yet — the invoice/quote uses the deal value as a single line until you add some.</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderTop: '1px solid var(--bord)' }}>
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: 'var(--text-mute)' }}>Deal value auto-sums from products</span>
        <span className="t-num" style={{ fontSize: 15, fontWeight: 800 }}>{fmtCur(deal.products.length ? total : parseFloat(deal.value_amount), deal.currency)}</span>
        {deal.currency !== deal.base_currency && (
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)' }}>≈ {fmtCur(parseFloat(deal.value_base_amount), deal.base_currency)}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '0 18px 16px' }}>
        <Btn kind="primary" size="sm" icon={<Icon.receipt size={13} />} onClick={onCreateInvoice} disabled={busy}>Create invoice{deal.products.length ? ' from products' : ''}</Btn>
        <Btn kind="secondary" size="sm" icon={<Icon.doc size={13} />} onClick={onCreateQuote} disabled={busy}>Create quote</Btn>
      </div>
    </div>
  )
}

// ── People tab (deal participants) ──
function PeopleTab({ deal }: { deal: DealDetail }) {
  const addPerson = useAddDealPerson()
  const removePerson = useRemoveDealPerson()
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const contacts = useContacts(adding ? { q } : undefined)
  const already = new Set(deal.people.map((p) => p.person_id))
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {deal.people.map((p, i) => (
        <div key={p.person_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: '1px solid var(--bord)' }}>
          <OwnerAv name={p.name} size={30} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800 }}>{p.name ?? '—'}</div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{[p.title, p.email].filter(Boolean).join(' · ') || '—'}</div>
          </div>
          <Pill tone={i === 0 ? 'blue' : ''}>{p.role ?? 'participant'}</Pill>
          {p.phone && <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{p.phone}</span>}
          <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} onClick={() => removePerson.mutate({ dealId: deal.id, personId: p.person_id })} />
        </div>
      ))}
      {deal.people.length === 0 && !adding && (
        <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No participants yet — link the people you're selling to.</div>
      )}
      <div style={{ padding: '12px 18px' }}>
        {adding ? (
          <div>
            <input autoFocus className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts…" style={{ height: 32, fontSize: 12, width: 280, marginBottom: 8 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 200, overflowY: 'auto' }}>
              {(contacts.data?.data ?? []).filter((c) => !already.has(c.id)).slice(0, 8).map((c) => (
                <button key={c.id} onClick={() => { addPerson.mutate({ dealId: deal.id, body: { person_id: c.id } }); setAdding(false); setQ('') }}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surf-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                  <OwnerAv name={c.display_name} size={22} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{c.display_name ?? c.email}</span>
                  <span className="t-mute" style={{ fontSize: 10.5 }}>{c.email}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Btn kind="ghost" size="sm" icon={<Icon.userPlus size={13} />} onClick={() => setAdding(true)}>Add participant</Btn>
        )}
      </div>
    </div>
  )
}

// ── Details tab — standard + custom fields (§9.1) ──
function DetailsTab({ deal, pipelineName, stageName, stageProb }: { deal: DealDetail; pipelineName?: string; stageName?: string; stageProb?: number }) {
  const update = useUpdateDeal()
  const customFields = useCustomFields('deal')
  const { toast } = useToast()
  const custom = (deal.custom ?? {}) as Record<string, unknown>

  const saveCustom = (key: string, value: unknown) => {
    update.mutate({ id: deal.id, body: { custom: { ...custom, [key]: value } } }, {
      onError: (err) => toast({ title: 'Could not save', description: err instanceof Error ? err.message : undefined, variant: 'destructive' }),
    })
  }

  return (
    <div className="card">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Pipeline" value={pipelineName ?? '—'} readOnly />
        <Field label="Stage" value={stageName ? `${stageName} · ${stageProb}%` : '—'} readOnly />
        <Field label="Source" value={deal.source ?? 'manual'} readOnly />
        <Field label="Owner" value={deal.owner_name ?? '—'} readOnly />
        <Field label="Expected close" value={deal.expected_close_date ?? ''} type="date"
          onSave={(v) => update.mutate({ id: deal.id, body: { expected_close_date: v || null } })} />
        <Field label={`Value (${deal.currency})`} value={deal.value_amount} type="number"
          onSave={(v) => { const n = parseFloat(v); if (Number.isFinite(n) && n >= 0) update.mutate({ id: deal.id, body: { value_amount: n } }) }} />
        {(customFields.data?.data ?? []).map((f) => (
          f.field_type === 'select' ? (
            <div key={f.id}>
              <div className="label">{f.label} <span style={{ color: 'var(--text-faint)' }}>· custom</span></div>
              <select className="input" value={String(custom[f.key] ?? '')} onChange={(e) => saveCustom(f.key, e.target.value)} style={{ height: 38, fontSize: 12.5, width: '100%' }}>
                <option value="">—</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ) : f.field_type === 'checkbox' ? (
            <div key={f.id}>
              <div className="label">{f.label} <span style={{ color: 'var(--text-faint)' }}>· custom</span></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                <input type="checkbox" checked={custom[f.key] === true} onChange={(e) => saveCustom(f.key, e.target.checked)} /> {custom[f.key] === true ? 'Yes' : 'No'}
              </label>
            </div>
          ) : (
            <Field key={f.id} label={f.label} custom value={custom[f.key] != null ? String(custom[f.key]) : ''}
              type={f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text'}
              onSave={(v) => saveCustom(f.key, f.field_type === 'number' ? (v === '' ? null : parseFloat(v)) : v || null)} />
          )
        ))}
      </div>
      <div className="t-caption" style={{ marginTop: 12 }}>
        Custom fields render everywhere — forms, filters, workflows, API. Owner/Admin define them (Settings → CRM).
      </div>
    </div>
  )
}

function Field({ label, value, type = 'text', readOnly, custom, onSave }: {
  label: string; value: string; type?: string; readOnly?: boolean; custom?: boolean; onSave?: (v: string) => void
}) {
  const [v, setV] = useState(value)
  return (
    <div>
      <div className="label">{label} {custom && <span style={{ color: 'var(--text-faint)' }}>· custom</span>}</div>
      <input className="input" type={type} value={v} readOnly={readOnly}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (!readOnly && onSave && v !== value) onSave(v) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        style={{ height: 38, fontSize: 12.5, width: '100%', opacity: readOnly ? 0.75 : 1 }} />
    </div>
  )
}
