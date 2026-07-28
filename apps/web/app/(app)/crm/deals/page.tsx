'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import { api } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useQuickAdd } from '@/lib/stores/quick-add.store'
import { TagChip, OwnerAv, EmptyState, SavedViewTabs, FilterBar, BulkBar, KeymapOverlay, fmtCur, type FilterChip } from '@/components/crm/kit'
import { Sk } from '@/components/states'
import { WonDialog, LostDialog } from '@/components/crm/deal-dialogs'
import {
  useBoard,
  usePipelines,
  useForecast,
  useLostReasons,
  useReps,
  useCreateDeal,
  useMoveDeal,
  useUpdateDeal,
  useDeleteDeal,
  useSavedViews,
  useCreateSavedView,
  useCreateInvoiceFromDeal,
  type DealCard as TDeal,
  type BoardColumn,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C2 — Deals kanban (scr-board.jsx, ported to live data)
// drag-drop · rotting · weighted chips · inline quick-add ·
// inline edit · bulk · saved views · keymap · Won/Lost zones
// + mobile swimlane (§19.9)
// ─────────────────────────────────────────────────────────

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED']

function useIsMobile() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)')
    const apply = () => setMobile(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return mobile
}

export default function DealsBoardPage() {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useAuthStore()
  const isMobile = useIsMobile()

  const pipelines = usePipelines()
  const [pipelineId, setPipelineId] = useState<string | undefined>()
  const board = useBoard(pipelineId)
  const forecast = useForecast(pipelineId)
  const lostReasons = useLostReasons()
  const reps = useReps()
  const savedViews = useSavedViews('deal')
  const createView = useCreateSavedView()
  const move = useMoveDeal()
  const update = useUpdateDeal()
  const del = useDeleteDeal()
  const createInvoice = useCreateInvoiceFromDeal()
  const createProjectFromDeal = useMutation({
    mutationFn: (dealId: string) =>
      api.post<{ data: { id: string } }>('/api/v1/pm/projects/from-deal', { deal_id: dealId }),
  })

  // Board interaction state
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [sel, setSel] = useState<string[]>([])
  const [view, setView] = useState('all')
  const [search, setSearch] = useState('')
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null)
  const [quickAddCol, setQuickAddCol] = useState<string | null>(null)
  const [keymap, setKeymap] = useState(false)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [wonDeal, setWonDeal] = useState<TDeal | null>(null)
  const [lostDeal, setLostDeal] = useState<TDeal | null>(null)
  const [bulkStagePick, setBulkStagePick] = useState(false)

  const data = board.data?.data
  const base = data?.base_currency ?? 'INR'
  const pl = pipelines.data?.data.find((p) => p.id === data?.pipeline.id)
  const wonStage = pl?.stages.find((s) => s.stage_type === 'won')
  const lostStage = pl?.stages.find((s) => s.stage_type === 'lost')
  const f = forecast.data?.data

  const quickAdd = useQuickAdd()

  // ? opens the keymap (N is handled globally by QuickAddGlobal in the layout).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.key === '?') { e.preventDefault(); setKeymap((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Built-in views + saved views from the API (§9.2).
  const viewTabs = useMemo(() => [
    { id: 'all', label: 'All open' },
    { id: 'mine', label: 'My deals', priv: true },
    { id: 'rot', label: 'Rotting', priv: true },
    ...(savedViews.data?.data.map((v) => ({ id: `sv:${v.id}`, label: v.name, team: v.is_shared, priv: !v.is_shared })) ?? []),
  ], [savedViews.data])

  const cardFilter = (d: TDeal): boolean => {
    if (view === 'mine' && d.owner_user_id !== currentUser?.id) return false
    if (view === 'rot' && !d.rot_state) return false
    if (view.startsWith('sv:')) {
      const sv = savedViews.data?.data.find((v) => `sv:${v.id}` === view)
      const fl = (sv?.filters ?? {}) as { q?: string; owner_user_id?: string }
      if (fl.q && !d.title.toLowerCase().includes(fl.q.toLowerCase())) return false
      if (fl.owner_user_id && d.owner_user_id !== fl.owner_user_id) return false
    }
    if (search && !d.title.toLowerCase().includes(search.toLowerCase())) return false
    if (ownerFilter && d.owner_user_id !== ownerFilter) return false
    return true
  }

  const columns = (data?.columns ?? []).map((c) => ({ ...c, cards: c.cards.filter(cardFilter) }))
  const totalDeals = (data?.columns ?? []).reduce((a, c) => a + c.count, 0)

  const doMove = async (dealId: string, stageId: string, opts?: { lost_reason_id?: string; lost_reason_note?: string }) => {
    try {
      await move.mutateAsync({ id: dealId, body: { stage_id: stageId, ...opts } })
      return true
    } catch (err) {
      toast({ title: 'Could not move deal', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
      return false
    }
  }

  const findDeal = (id: string) => data?.columns.flatMap((c) => c.cards).find((d) => d.id === id)

  const dropToStage = (stageId: string) => {
    if (drag) void doMove(drag, stageId)
    setDrag(null); setOver(null)
  }
  const dropWon = async () => {
    const d = drag ? findDeal(drag) : null
    setDrag(null); setOver(null)
    if (!d || !wonStage) return
    if (await doMove(d.id, wonStage.id)) setWonDeal(d)
  }
  const dropLost = () => {
    const d = drag ? findDeal(drag) : null
    setDrag(null); setOver(null)
    if (d) setLostDeal(d) // reason required — dialog confirms the move
  }

  const onWonCreateInvoice = async () => {
    if (!wonDeal) return
    try {
      await createInvoice.mutateAsync(wonDeal.id)
      toast({ title: 'Draft invoice created', description: 'Opening Invoicing → Invoices.' })
      setWonDeal(null)
      router.push('/invoicing/invoices')
    } catch (err) {
      toast({ title: 'Could not create invoice', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const bulk = {
    moveStage: async (stageId: string) => {
      for (const id of sel) await doMove(id, stageId)
      setSel([]); setBulkStagePick(false)
    },
    del: async () => {
      if (!window.confirm(`Delete ${sel.length} deal(s)? This can't be undone.`)) return
      for (const id of sel) {
        try { await del.mutateAsync(id) } catch { /* per-deal toast is noise in bulk */ }
      }
      setSel([])
    },
  }

  const chips: FilterChip[] = ownerFilter
    ? [{ key: 'owner', label: 'Owner', value: reps.data?.data.find((r) => r.user_id === ownerFilter)?.name ?? '—' }]
    : []

  if (isMobile) {
    return <MobileSwimlane columns={data?.columns ?? []} base={base} onOpen={(id) => router.push(`/crm/deals/${id}`)} onQuickAdd={() => quickAdd.openWith('deal')} quickAddCol={quickAddCol} pipelineId={data?.pipeline.id} onCloseQuickAdd={() => setQuickAddCol(null)} />
  }

  return (
    <div style={{ padding: '24px 24px 64px' }}>
      {/* Board header: pipeline switcher · views · chips · keymap · new deal */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="input" value={pipelineId ?? data?.pipeline.id ?? ''} onChange={(e) => setPipelineId(e.target.value || undefined)} style={{ height: 36, width: 170, fontSize: 12.5, fontWeight: 800 }}>
          {(pipelines.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <SavedViewTabs views={viewTabs} active={view} onChange={setView} onSave={() => setSaveViewOpen(true)} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Pill tone="blue">Open {fmtCur(f?.open_value ?? 0, base)}</Pill>
          <Pill tone="purple">Weighted {fmtCur(f?.weighted_value ?? 0, base)}</Pill>
          <Pill tone="green">Won {fmtCur(f?.won_value ?? 0, base)}</Pill>
        </div>
        <button onClick={() => setKeymap(true)} title="Keyboard (?)" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon.keyboard size={15} />
        </button>
        <Btn kind="primary" size="sm" icon={<Icon.plus size={14} />} onClick={() => quickAdd.openWith('deal')}>
          New deal <span style={{ opacity: 0.6, fontFamily: 'var(--font-mono)', fontSize: 10 }}>N</span>
        </Btn>
      </div>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search deals…"
        chips={chips}
        onRemoveChip={() => setOwnerFilter(null)}
        addFilter={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Where</span>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Owner is</span>
            <select className="input" value={ownerFilter ?? ''} onChange={(e) => setOwnerFilter(e.target.value || null)} style={{ height: 34, width: 190, fontSize: 12 }}>
              <option value="">Anyone</option>
              {(reps.data?.data ?? []).map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
            </select>
          </div>
        }
      />

      {board.isLoading ? (
        // Cold load only — a warm cache renders the board instantly.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(218px, 1fr))', gap: 12, alignItems: 'start' }}>
          {[0, 1, 2, 3].map((c) => (
            <div key={c} className="card" style={{ padding: 10 }}>
              <Sk w={90} h={9} style={{ marginBottom: 12 }} />
              {[0, 1, 2].map((r) => (
                <div key={r} style={{ padding: '9px 0', borderTop: r ? '1px solid var(--bord)' : 'none' }}>
                  <Sk w="80%" h={10} style={{ marginBottom: 7 }} />
                  <Sk w="55%" h={8} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : totalDeals === 0 ? (
        <EmptyState
          icon={<Icon.kanban size={22} />}
          line="No deals yet. Create your first deal and start moving it through the pipeline — imports from Pipedrive, HubSpot and CSV arrive with the reports phase."
          cta="New deal"
          onCta={() => quickAdd.openWith('deal')}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, minmax(218px, 1fr))`, gap: 12, alignItems: 'start', overflowX: 'auto', paddingBottom: 8 }}>
          {columns.map((col) => (
            <Column
              key={col.stage.id}
              col={col}
              base={base}
              over={over === col.stage.id}
              onDragOver={() => setOver(col.stage.id)}
              onDragLeave={() => setOver((o) => (o === col.stage.id ? null : o))}
              onDrop={() => dropToStage(col.stage.id)}
              selected={sel}
              onSelect={(id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
              onOpen={(id) => router.push(`/crm/deals/${id}`)}
              dragId={drag}
              setDrag={setDrag}
              clearDrag={() => { setDrag(null); setOver(null) }}
              quickAddOpen={quickAddCol === col.stage.id}
              setQuickAdd={(open) => setQuickAddCol(open ? col.stage.id : null)}
              pipelineId={data?.pipeline.id}
              onInlineEdit={(id, patch) => update.mutate({ id, body: patch })}
              reps={reps.data?.data ?? []}
            />
          ))}
        </div>
      )}

      {/* Won / Lost drop zones — fixed bottom bar while dragging */}
      {drag && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 60, display: 'flex', gap: 12, padding: '14px 24px', background: 'rgba(1,1,13,.9)', backdropFilter: 'blur(10px)', borderTop: '1px solid var(--bord-2)' }}>
          <div onDragOver={(e) => e.preventDefault()} onDrop={dropWon}
            style={{ flex: 1, padding: 16, borderRadius: 12, border: '1.5px dashed rgba(39,210,128,.5)', background: 'rgba(39,210,128,.07)', textAlign: 'center', fontSize: 13, fontWeight: 800, color: 'var(--green)' }}>
            🏆 Drop to mark WON
          </div>
          <div onDragOver={(e) => e.preventDefault()} onDrop={dropLost}
            style={{ flex: 1, padding: 16, borderRadius: 12, border: '1.5px dashed rgba(248,120,107,.5)', background: 'rgba(248,120,107,.07)', textAlign: 'center', fontSize: 13, fontWeight: 800, color: 'var(--coral)' }}>
            Drop to mark LOST
          </div>
        </div>
      )}

      <BulkBar
        count={sel.length}
        onClear={() => setSel([])}
        actions={[
          { icon: <Icon.switchH size={13} />, label: 'Move stage', onClick: () => setBulkStagePick(true) },
          { icon: <Icon.trash size={13} />, label: 'Delete', danger: true, onClick: () => void bulk.del() },
        ]}
      />
      {bulkStagePick && (
        <div onClick={() => setBulkStagePick(false)} style={{ position: 'fixed', inset: 0, zIndex: 80 }}>
          <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ position: 'fixed', bottom: 84, left: '50%', transform: 'translateX(-50%)', borderRadius: 12, padding: 6, display: 'flex', gap: 4, zIndex: 90 }}>
            {(pl?.stages ?? []).filter((s) => s.stage_type === 'open').map((s) => (
              <button key={s.id} onClick={() => void bulk.moveStage(s.id)} style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--surf-1)', border: '1px solid var(--bord)', color: '#fff', fontSize: 11.5, fontWeight: 800, cursor: 'pointer' }}>
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="t-caption" style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>⇧ click — multi-select</span>
        <span>drag between stages — optimistic, broadcast live</span>
        <span>drag down — Won / Lost</span>
        <span>? — keymap</span>
      </div>

      <KeymapOverlay open={keymap} onClose={() => setKeymap(false)} />

      {wonDeal && (
        <WonDialog
          open
          onClose={() => setWonDeal(null)}
          deal={{
            title: wonDeal.title,
            companyName: null,
            value: parseFloat(wonDeal.value_amount),
            currency: wonDeal.currency,
            base,
            baseValue: parseFloat(wonDeal.value_base_amount),
            productCount: 0,
            customerLinked: false,
          }}
          busy={createInvoice.isPending || createProjectFromDeal.isPending}
          onCreateInvoice={() => void onWonCreateInvoice()}
          onCreateQuote={() => { setWonDeal(null); router.push(`/crm/deals/${wonDeal.id}`) }}
          onCreateProject={() => {
            const dealId = wonDeal.id
            createProjectFromDeal.mutate(dealId, {
              onSuccess: (r) => { setWonDeal(null); toast({ title: 'Project created from deal' }); router.push(`/pm/projects/${r.data.id}`) },
              onError: (e) => toast({ title: 'Could not create project', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
            })
          }}
        />
      )}

      {lostDeal && lostStage && (
        <LostDialog
          open
          onClose={() => setLostDeal(null)}
          reasons={lostReasons.data?.data ?? []}
          busy={move.isPending}
          onConfirm={async (reasonId, note) => {
            const ok = await doMove(lostDeal.id, lostStage.id, { lost_reason_id: reasonId, ...(note ? { lost_reason_note: note } : {}) })
            if (ok) setLostDeal(null)
          }}
        />
      )}

      {saveViewOpen && (
        <SaveViewModal
          onClose={() => setSaveViewOpen(false)}
          onSave={async (name, shared) => {
            try {
              await createView.mutateAsync({ object_type: 'deal', name, is_shared: shared, filters: { q: search || undefined, owner_user_id: ownerFilter || undefined } })
              toast({ title: 'View saved' })
              setSaveViewOpen(false)
            } catch (err) {
              toast({ title: 'Could not save view', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
            }
          }}
        />
      )}
    </div>
  )
}

// ── Column ──
function Column({ col, base, over, onDragOver, onDragLeave, onDrop, selected, onSelect, onOpen, dragId, setDrag, clearDrag, quickAddOpen, setQuickAdd, pipelineId, onInlineEdit, reps }: {
  col: BoardColumn & { cards: TDeal[] }
  base: string
  over: boolean
  onDragOver: () => void
  onDragLeave: () => void
  onDrop: () => void
  selected: string[]
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  dragId: string | null
  setDrag: (id: string) => void
  clearDrag: () => void
  quickAddOpen: boolean
  setQuickAdd: (open: boolean) => void
  pipelineId?: string
  onInlineEdit: (id: string, patch: Record<string, unknown>) => void
  reps: Array<{ user_id: string; name: string }>
}) {
  const st = col.stage
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onDragOver() }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ borderRadius: 13, padding: '10px 10px 12px', background: over ? 'rgba(62,123,250,.06)' : 'rgba(255,255,255,.015)', border: `1px dashed ${over ? 'rgba(62,123,250,.5)' : 'var(--bord)'}`, transition: 'all .15s', minHeight: 220 }}
    >
      <div style={{ padding: '2px 4px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '-0.01em' }}>{st.name}</span>
          <span className="t-caption" style={{ fontSize: 9.5 }}>{st.win_probability}%</span>
          {st.rotting_days != null && (
            <span title={`Deals rot after ${st.rotting_days} idle days`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontWeight: 800, color: 'var(--text-faint)' }}>
              <Icon.clock size={9} />{st.rotting_days}d
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{col.cards.length}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span className="t-num" style={{ fontSize: 12.5, fontWeight: 800 }}>{fmtCur(col.sum_base, base)}</span>
          <span title="Weighted by stage probability" style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>w {fmtCur(col.weighted_base, base)}</span>
        </div>
      </div>

      {/* Drop line — flat 2px blue rule where the card will land (catalog). */}
      {over && (
        <div className="pm-fade" style={{ height: 2, borderRadius: 2, background: 'var(--blue)', margin: '0 2px 8px' }} />
      )}

      {col.cards.map((d) => (
        <DealCardView key={d.id} d={d} base={base} selected={selected.includes(d.id)} dragging={dragId === d.id}
          onSelect={() => onSelect(d.id)} onOpen={() => onOpen(d.id)}
          onDragStart={() => setDrag(d.id)} onDragEnd={clearDrag}
          onInlineEdit={(patch) => onInlineEdit(d.id, patch)} reps={reps} />
      ))}

      {quickAddOpen ? (
        <InlineQuickAdd stageId={st.id} pipelineId={pipelineId} base={base} onClose={() => setQuickAdd(false)} />
      ) : (
        <button onClick={() => setQuickAdd(true)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 8, borderRadius: 10, background: 'transparent', border: '1px dashed var(--bord)', color: 'var(--text-faint)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.borderColor = 'var(--bord-2)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.borderColor = 'var(--bord)' }}>
          <Icon.plus size={12} /> Add deal
        </button>
      )}
    </div>
  )
}

// ── Deal card ──
function DealCardView({ d, base, selected, dragging, onSelect, onOpen, onDragStart, onDragEnd, onInlineEdit, reps }: {
  d: TDeal
  base: string
  selected: boolean
  dragging: boolean
  onSelect: () => void
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onInlineEdit: (patch: Record<string, unknown>) => void
  reps: Array<{ user_id: string; name: string }>
}) {
  const [editingValue, setEditingValue] = useState(false)
  const [editingDate, setEditingDate] = useState(false)
  const [pickOwner, setPickOwner] = useState(false)
  const rot = d.rot_state

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => { if (e.shiftKey) onSelect(); else onOpen() }}
      tabIndex={0}
      style={{
        padding: '11px 12px', borderRadius: 11, cursor: 'grab', marginBottom: 8, position: 'relative',
        background: selected ? 'rgba(62,123,250,.12)' : 'var(--surf-1)',
        border: `1px solid ${selected ? 'rgba(62,123,250,.5)' : rot === 'red' ? 'rgba(248,120,107,.45)' : rot === 'amber' ? 'rgba(254,216,0,.35)' : 'var(--bord)'}`,
        opacity: dragging ? 0.4 : 1, transition: 'border-color .15s, background .15s',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--surf-2)' }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'var(--surf-1)' }}
    >
      {rot && (
        <span title={`Idle ${d.idle_days}d in this stage`} style={{ position: 'absolute', top: 9, right: 10, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 800, letterSpacing: '.04em', color: rot === 'red' ? 'var(--coral)' : 'var(--yellow)' }}>
          <Icon.clock size={10} /> {d.idle_days}d
        </span>
      )}
      <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 5, paddingRight: rot ? 38 : 0, lineHeight: 1.35 }}>{d.title}</div>
      <div style={{ marginBottom: 7 }}>
        {editingValue ? (
          <input autoFocus className="input t-num" defaultValue={d.value_amount}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { setEditingValue(false); const v = parseFloat(e.target.value.replace(/,/g, '')); if (Number.isFinite(v) && v >= 0) onInlineEdit({ value_amount: v }) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingValue(false) }}
            style={{ height: 26, fontSize: 11.5, width: 110, padding: '0 8px' }} />
        ) : (
          <span onClick={(e) => { e.stopPropagation(); setEditingValue(true) }} title="Click to edit value inline" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7 }}>
            <span className="t-num" style={{ fontSize: 12.5, fontWeight: 800 }}>{fmtCur(parseFloat(d.value_amount), d.currency)}</span>
            {d.currency !== base && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)' }}>≈ {fmtCur(parseFloat(d.value_base_amount), base)}</span>}
          </span>
        )}
      </div>
      {(d.tags ?? []).length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 7 }}>
          {d.tags!.map((t) => <TagChip key={t.id} tag={t} small />)}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ position: 'relative', lineHeight: 0 }} onClick={(e) => { e.stopPropagation(); setPickOwner((o) => !o) }}>
          <span title="Click to change owner" style={{ cursor: 'pointer', display: 'inline-flex' }}>
            <OwnerAv name={d.owner_name ?? null} size={20} />
          </span>
          {pickOwner && (
            <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60, width: 172, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 5, boxShadow: '0 16px 40px rgba(0,0,0,.5)' }}>
              {reps.map((r) => (
                <button key={r.user_id} onClick={(e) => { e.stopPropagation(); setPickOwner(false); onInlineEdit({ owner_user_id: r.user_id }) }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 7px', borderRadius: 7, background: r.user_id === d.owner_user_id ? 'var(--surf-2)' : 'transparent', border: 'none', cursor: 'pointer' }}>
                  <OwnerAv name={r.name} size={18} /><span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{r.name}</span>
                </button>
              ))}
            </div>
          )}
        </span>
        {d.next_activity_at ? (
          <span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'var(--text-mute)', minWidth: 0 }}>
            <Icon.cal size={10} style={{ flexShrink: 0, color: 'var(--blue)' }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{new Date(d.next_activity_at).toLocaleDateString()}</span>
          </span>
        ) : (
          <span title="Activity-based selling: schedule the next step" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 800, color: 'var(--coral)' }}>
            <Icon.warn size={10} /> No next activity
          </span>
        )}
        {editingDate ? (
          <span onClick={(e) => e.stopPropagation()}>
            <DateField
              value={d.expected_close_date ?? ''}
              defaultOpen
              onChange={(iso) => { setEditingDate(false); if (iso) onInlineEdit({ expected_close_date: iso }) }}
              style={{ height: 24, width: 130, fontSize: 9.5, padding: '0 6px' }}
            />
          </span>
        ) : (
          <span onClick={(e) => { e.stopPropagation(); setEditingDate(true) }} title={d.expected_close_date ? `Close ${d.expected_close_date} — click to edit` : 'Set expected close'} className="t-caption" style={{ fontSize: 9.5, whiteSpace: 'nowrap', cursor: 'pointer' }}>
            {d.expected_close_date ?? 'no close date'}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Inline column quick-add ──
function InlineQuickAdd({ stageId, pipelineId, base, onClose }: { stageId: string; pipelineId?: string; base: string; onClose: () => void }) {
  const create = useCreateDeal()
  const { toast } = useToast()
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [cur, setCur] = useState(base)
  const submit = async () => {
    if (!title.trim()) return
    try {
      await create.mutateAsync({ title, value_amount: value ? parseFloat(value) : 0, currency: cur, stage_id: stageId, pipeline_id: pipelineId })
      onClose()
    } catch (err) {
      toast({ title: 'Could not create deal', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  const currencies = [base, ...CURRENCIES.filter((c) => c !== base)]
  return (
    <div style={{ padding: '9px 10px', borderRadius: 11, background: 'var(--surf-1)', border: '1px solid var(--bord-2)' }}>
      <input autoFocus className="input" placeholder="Deal title…" value={title} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter') void submit() }}
        style={{ height: 30, fontSize: 12, marginBottom: 6, width: '100%' }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input t-num" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} style={{ height: 28, fontSize: 11, flex: 1, minWidth: 0 }} />
        <select className="input" value={cur} onChange={(e) => setCur(e.target.value)} style={{ height: 28, fontSize: 11, width: 70 }}>
          {currencies.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
        <Btn kind="ghost" size="sm" onClick={onClose}>Esc</Btn>
        <Btn kind="primary" size="sm" icon={<Icon.check size={12} />} onClick={() => void submit()} disabled={!title.trim() || create.isPending}>
          {create.isPending ? '…' : 'Add'}
        </Btn>
      </div>
    </div>
  )
}

// ── Save-view modal (C20 "+") ──
function SaveViewModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string, shared: boolean) => void }) {
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 380, borderRadius: 16, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 12 }}>Save view</div>
        <div className="label">Name</div>
        <input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enterprise · Q3" style={{ width: '100%' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 700, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the team
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn kind="ghost" size="sm" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} disabled={!name.trim()} onClick={() => onSave(name.trim(), shared)}>Save</Btn>
        </div>
      </div>
    </div>
  )
}

// ── Mobile 390px — stage-grouped swimlane (§19.9) ──
function MobileSwimlane({ columns, base, onOpen, onQuickAdd, quickAddCol, pipelineId, onCloseQuickAdd }: {
  columns: Array<BoardColumn & { cards: TDeal[] }>
  base: string
  onOpen: (id: string) => void
  onQuickAdd: () => void
  quickAddCol: string | null
  pipelineId?: string
  onCloseQuickAdd: () => void
}) {
  const total = columns.reduce((a, c) => a + c.sum_base, 0)
  return (
    <div style={{ fontSize: 13, minHeight: '100vh' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'rgba(1,1,13,.92)', backdropFilter: 'blur(10px)', padding: '14px 14px 8px', borderBottom: '1px solid var(--bord)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Deals</span>
          <Pill tone="blue">{fmtCur(total, base)}</Pill>
        </div>
      </div>
      {columns.map((col) => {
        if (!col.cards.length) return null
        return (
          <div key={col.stage.id}>
            <div style={{ position: 'sticky', top: 52, zIndex: 10, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: 'rgba(10,10,20,.96)', borderBottom: '1px solid var(--bord)' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800 }}>{col.stage.name}</span>
              <span className="t-caption" style={{ fontSize: 9.5 }}>{col.stage.win_probability}%</span>
              <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>
                {col.cards.length} · {fmtCur(col.sum_base, base)}
              </span>
            </div>
            {col.cards.map((d) => (
              <div key={d.id} onClick={() => onOpen(d.id)} style={{ padding: '12px 14px', borderBottom: '1px solid var(--bord)', display: 'flex', gap: 11, alignItems: 'center', cursor: 'pointer' }}>
                <OwnerAv name={d.owner_name ?? null} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div>
                  <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 2 }}>
                    <span className="t-num" style={{ fontSize: 11, fontWeight: 800 }}>{fmtCur(parseFloat(d.value_amount), d.currency)}</span>
                    {d.rot_state && <span style={{ fontSize: 9, fontWeight: 800, color: d.rot_state === 'red' ? 'var(--coral)' : 'var(--yellow)' }}>idle {d.idle_days}d</span>}
                    {!d.next_activity_at && <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--coral)' }}>no next</span>}
                  </div>
                </div>
                <Icon.chevR size={15} style={{ color: 'var(--text-faint)' }} />
              </div>
            ))}
          </div>
        )
      })}
      <div style={{ height: 76 }} />
      <div style={{ position: 'sticky', bottom: 0, display: 'flex', gap: 8, padding: '10px 14px 16px', background: 'linear-gradient(180deg,transparent,rgba(1,1,13,.95) 30%)' }}>
        <Btn kind="primary" style={{ flex: 1, justifyContent: 'center', height: 44 }} icon={<Icon.plus size={15} />} onClick={onQuickAdd}>Deal</Btn>
      </div>
      {quickAddCol && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }} onClick={onCloseQuickAdd}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: 'rgba(18,18,30,.99)', borderTop: '1px solid var(--bord-2)', borderRadius: '18px 18px 0 0', padding: '18px 16px 22px' }}>
            <div style={{ width: 36, height: 4, borderRadius: 99, background: 'var(--bord-2)', margin: '0 auto 14px' }} />
            <InlineQuickAdd stageId={quickAddCol} pipelineId={pipelineId} base={base} onClose={onCloseQuickAdd} />
          </div>
        </div>
      )}
    </div>
  )
}
