'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Loader2, Trophy, XCircle } from 'lucide-react'
import { Btn, SectionHead } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useBoard,
  usePipelines,
  useLostReasons,
  useCreateDeal,
  useMoveDeal,
  type DealCard,
  type BoardColumn,
} from '@/lib/api/queries/use-crm'

function fmt(n: number, cur: string) {
  return `${cur === 'INR' ? '₹' : cur + ' '}${Math.round(n).toLocaleString('en-IN')}`
}

export default function DealsBoardPage() {
  const pipelines = usePipelines()
  const [pipelineId, setPipelineId] = useState<string | undefined>()
  const board = useBoard(pipelineId)
  const move = useMoveDeal()
  const lostReasons = useLostReasons()
  const { toast } = useToast()
  const [dragId, setDragId] = useState<string | null>(null)
  const [quickAddStage, setQuickAddStage] = useState<string | null>(null)

  const data = board.data?.data
  const base = data?.base_currency ?? 'INR'
  const totals = useMemo(() => {
    const cols = data?.columns ?? []
    return {
      sum: cols.reduce((a, c) => a + c.sum_base, 0),
      weighted: cols.reduce((a, c) => a + c.weighted_base, 0),
      count: cols.reduce((a, c) => a + c.count, 0),
    }
  }, [data])

  const wonStage = pipelines.data?.data.find((p) => p.id === data?.pipeline.id)?.stages.find((s) => s.stage_type === 'won')
  const lostStage = pipelines.data?.data.find((p) => p.id === data?.pipeline.id)?.stages.find((s) => s.stage_type === 'lost')

  const doMove = async (dealId: string, stageId: string, opts?: { lost_reason_id?: string; lost_reason_note?: string }) => {
    try {
      await move.mutateAsync({ id: dealId, body: { stage_id: stageId, ...opts } })
    } catch (err) {
      toast({ title: 'Could not move deal', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const onDropToStage = (stageId: string) => {
    if (dragId) doMove(dragId, stageId)
    setDragId(null)
  }
  const onDropLost = () => {
    if (!dragId || !lostStage) return
    const reason = lostReasons.data?.data[0]
    doMove(dragId, lostStage.id, reason ? { lost_reason_id: reason.id } : { lost_reason_note: 'Lost' })
    setDragId(null)
  }

  return (
    <div style={{ padding: '24px 24px 64px' }}>
      <SectionHead
        title="Deals"
        sub={data ? `${data.pipeline.name} · ${totals.count} open` : 'Your pipeline'}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(pipelines.data?.data.length ?? 0) > 1 && (
              <select className="input" value={pipelineId ?? ''} onChange={(e) => setPipelineId(e.target.value || undefined)} style={{ height: 34 }}>
                <option value="">{pipelines.data!.data.find((p) => p.is_default)?.name ?? 'Default'}</option>
                {pipelines.data!.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <Btn kind="primary" size="sm" icon={<Plus size={14} />} onClick={() => setQuickAddStage(data?.columns[0]?.stage.id ?? null)}>New deal</Btn>
          </div>
        }
      />

      {/* Header chips: total + weighted */}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <Chip label="Pipeline value" value={fmt(totals.sum, base)} />
        <Chip label="Weighted" value={fmt(totals.weighted, base)} tone="blue" />
      </div>

      {board.isLoading ? (
        <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginTop: 18, overflowX: 'auto', alignItems: 'flex-start', paddingBottom: 8 }}>
            {(data?.columns ?? []).map((col) => (
              <Column
                key={col.stage.id}
                col={col}
                base={base}
                onDrop={() => onDropToStage(col.stage.id)}
                onDragOverCard={() => undefined}
                setDragId={setDragId}
                quickAddOpen={quickAddStage === col.stage.id}
                onQuickAddToggle={(open) => setQuickAddStage(open ? col.stage.id : null)}
                pipelineId={data?.pipeline.id}
              />
            ))}
          </div>

          {/* Won / Lost drop zones (appear useful while dragging) */}
          {dragId && (wonStage || lostStage) && (
            <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
              {wonStage && (
                <DropZone tone="green" label="Won" icon={<Trophy size={16} />} onDrop={() => (doMove(dragId, wonStage.id), setDragId(null))} />
              )}
              {lostStage && (
                <DropZone tone="coral" label="Lost" icon={<XCircle size={16} />} onDrop={onDropLost} />
              )}
            </div>
          )}
        </>
      )}

      {quickAddStage && (
        <QuickAddDeal
          stageId={quickAddStage}
          pipelineId={data?.pipeline.id}
          base={base}
          onClose={() => setQuickAddStage(null)}
        />
      )}
    </div>
  )
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: 'blue' }) {
  return (
    <div style={{ padding: '8px 14px', borderRadius: 10, background: tone === 'blue' ? 'rgba(62,123,250,.1)' : 'var(--surf-1)', border: `1px solid ${tone === 'blue' ? 'rgba(62,123,250,.3)' : 'var(--bord)'}` }}>
      <div className="t-mute" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{value}</div>
    </div>
  )
}

function Column({ col, base, onDrop, setDragId }: {
  col: BoardColumn; base: string; onDrop: () => void; onDragOverCard: () => void
  setDragId: (id: string) => void; quickAddOpen: boolean; onQuickAddToggle: (o: boolean) => void; pipelineId?: string
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={() => { setOver(false); onDrop() }}
      style={{ minWidth: 268, width: 268, flexShrink: 0, background: over ? 'rgba(62,123,250,.06)' : 'var(--surf-1)', border: `1px solid ${over ? 'rgba(62,123,250,.4)' : 'var(--bord)'}`, borderRadius: 12, padding: 10 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 4px 10px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{col.stage.name}</div>
        <div className="t-mute" style={{ fontSize: 11 }}>{col.count} · {fmt(col.sum_base, base)}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {col.cards.map((d) => <Card key={d.id} d={d} onDragStart={() => setDragId(d.id)} />)}
        {col.cards.length === 0 && <div className="t-mute" style={{ fontSize: 11.5, padding: '10px 4px', textAlign: 'center' }}>Drop deals here</div>}
      </div>
    </div>
  )
}

function Card({ d, onDragStart }: { d: DealCard; onDragStart: () => void }) {
  const rotColor = d.rot_state === 'red' ? 'var(--coral)' : d.rot_state === 'amber' ? 'var(--yellow)' : null
  return (
    <Link href={`/crm/deals/${d.id}`} draggable onDragStart={onDragStart} style={{
      display: 'block', textDecoration: 'none', color: 'inherit', cursor: 'grab',
      background: 'var(--surf-2)', border: `1px solid ${rotColor ?? 'var(--bord)'}`,
      borderLeft: rotColor ? `3px solid ${rotColor}` : '1px solid var(--bord)',
      borderRadius: 10, padding: '10px 12px',
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>{d.title}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 800 }}>{fmt(parseFloat(d.value_amount), d.currency)}</span>
        {rotColor && <span style={{ fontSize: 9.5, fontWeight: 800, color: rotColor }}>⏱ {d.idle_days}d</span>}
      </div>
    </Link>
  )
}

function DropZone({ tone, label, icon, onDrop }: { tone: 'green' | 'coral'; label: string; icon: React.ReactNode; onDrop: () => void }) {
  const [over, setOver] = useState(false)
  const color = tone === 'green' ? 'var(--green)' : 'var(--coral)'
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={() => { setOver(false); onDrop() }}
      style={{ flex: 1, padding: '18px', borderRadius: 12, border: `2px dashed ${color}`, background: over ? `${color}22` : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color, fontWeight: 800, fontSize: 13 }}
    >
      {icon} Drop to mark {label}
    </div>
  )
}

function QuickAddDeal({ stageId, pipelineId, base, onClose }: { stageId: string; pipelineId?: string; base: string; onClose: () => void }) {
  const create = useCreateDeal()
  const { toast } = useToast()
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const submit = async () => {
    try {
      await create.mutateAsync({ title, value_amount: value ? parseFloat(value) : 0, currency: base, stage_id: stageId, pipeline_id: pipelineId })
      toast({ title: 'Deal created' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not create deal', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(1,1,13,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ width: 380, background: 'var(--surf-2)', border: '1px solid var(--bord-2)', borderRadius: 14, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14 }}>New deal</div>
        <div className="label">Title</div>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme — annual renewal" style={{ width: '100%' }} autoFocus />
        <div className="label" style={{ marginTop: 10 }}>Value ({base})</div>
        <input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="50000" style={{ width: '100%' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={!title.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create'}</Btn>
        </div>
      </div>
    </div>
  )
}
