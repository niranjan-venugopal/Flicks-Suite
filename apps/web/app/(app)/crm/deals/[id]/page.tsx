'use client'

import { use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, FileText, Trophy } from 'lucide-react'
import { Btn, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useDeal,
  usePipelines,
  useCompany,
  useMoveDeal,
  useCreateInvoiceFromDeal,
} from '@/lib/api/queries/use-crm'

function fmt(n: number, cur: string) {
  return `${cur === 'INR' ? '₹' : cur + ' '}${Math.round(n).toLocaleString('en-IN')}`
}

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, isLoading, error } = useDeal(id)
  const pipelines = usePipelines()
  const move = useMoveDeal()
  const createInvoice = useCreateInvoiceFromDeal()
  const { toast } = useToast()
  const router = useRouter()
  const d = data?.data
  const company = useCompany(d?.company_id ?? null)

  if (isLoading) return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  if (error || !d) {
    return (
      <div style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Deal not found</div>
        <Link href="/crm/deals"><Btn kind="secondary" size="sm">Back to deals</Btn></Link>
      </div>
    )
  }

  const pipeline = pipelines.data?.data.find((p) => p.stages.some((s) => s.id === d.stage_id))
  const openStages = pipeline?.stages.filter((s) => s.stage_type === 'open') ?? []
  const currentIdx = openStages.findIndex((s) => s.id === d.stage_id)

  const doMove = async (stageId: string) => {
    try { await move.mutateAsync({ id, body: { stage_id: stageId } }) }
    catch (err) { toast({ title: 'Could not move', description: err instanceof Error ? err.message : undefined, variant: 'destructive' }) }
  }

  const onCreateInvoice = async () => {
    try {
      await createInvoice.mutateAsync(id)
      toast({ title: 'Draft invoice created', description: 'Opening Invoicing → Invoices to edit and send it.' })
      router.push('/invoicing/invoices')
    } catch (err) {
      toast({ title: 'Could not create invoice', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const wonStage = pipeline?.stages.find((s) => s.stage_type === 'won')

  return (
    <div style={{ padding: '24px 32px 64px', maxWidth: 920, margin: '0 auto' }}>
      <Link href="/crm/deals" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-mute)', textDecoration: 'none', fontSize: 12.5, marginBottom: 14 }}>
        <ArrowLeft size={14} /> Deals
      </Link>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800 }}>{d.title}</div>
            <div className="t-mute" style={{ fontSize: 13, marginTop: 2 }}>
              {company.data?.data.name ?? '—'} · {fmt(parseFloat(d.value_amount), d.currency)}
              {d.currency !== 'INR' && <span> · ≈ {fmt(parseFloat(d.value_base_amount), 'INR')}</span>}
            </div>
          </div>
          <Pill tone={d.status === 'won' ? 'green' : d.status === 'lost' ? 'coral' : 'blue'}>{d.status}</Pill>
        </div>

        {/* Stage stepper */}
        {d.status === 'open' && openStages.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 18, flexWrap: 'wrap' }}>
            {openStages.map((s, i) => {
              const done = i <= currentIdx
              return (
                <button key={s.id} onClick={() => doMove(s.id)} disabled={move.isPending} style={{
                  flex: 1, minWidth: 90, padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
                  background: done ? 'rgba(62,123,250,.15)' : 'var(--surf-1)',
                  border: `1px solid ${i === currentIdx ? 'var(--blue)' : done ? 'rgba(62,123,250,.3)' : 'var(--bord)'}`,
                  color: done ? '#fff' : 'var(--text-2)', fontSize: 11, fontWeight: 700,
                }}>{s.name}</button>
              )
            })}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <Btn kind="primary" size="sm" icon={<FileText size={14} />} onClick={onCreateInvoice} disabled={createInvoice.isPending}>
            {createInvoice.isPending ? 'Creating…' : 'Create invoice'}
          </Btn>
          {d.status === 'open' && wonStage && (
            <Btn kind="secondary" size="sm" icon={<Trophy size={14} />} onClick={() => doMove(wonStage.id)}>Mark Won</Btn>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
        <div className="t-caption">Details</div>
        <Row label="Value" value={`${fmt(parseFloat(d.value_amount), d.currency)}${d.currency !== 'INR' ? ` (≈ ${fmt(parseFloat(d.value_base_amount), 'INR')} base)` : ''}`} />
        <Row label="Expected close" value={d.expected_close_date ?? '—'} />
        <Row label="Idle" value={`${d.idle_days} day${d.idle_days === 1 ? '' : 's'} in stage`} />
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span className="t-mute" style={{ width: 120 }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}
