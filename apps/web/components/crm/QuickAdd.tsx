'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { useQuickAdd, type QuickAddKind } from '@/lib/stores/quick-add.store'
import {
  usePipelines,
  useCompanies,
  useCreateDeal,
  useCreateContact,
  useCreateCompany,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C7 — Global quick-add (crm-shared.jsx port, live data)
// N opens it anywhere in CRM · deal / person / company
// (lead & task kinds arrive with their phases)
// ─────────────────────────────────────────────────────────

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED']

const KINDS: Array<[QuickAddKind, string, keyof typeof Icon]> = [
  ['deal', 'Deal', 'target'],
  ['person', 'Person', 'user'],
  ['company', 'Company', 'building'],
]

export function QuickAddGlobal() {
  const { open, kind, openWith, close } = useQuickAdd()

  // N opens quick-add anywhere in the CRM section (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        openWith('deal')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openWith])

  if (!open) return null
  return <QuickAddModal kind={kind} onKind={(k) => openWith(k)} onClose={close} />
}

function QuickAddModal({ kind, onKind, onClose }: { kind: QuickAddKind; onKind: (k: QuickAddKind) => void; onClose: () => void }) {
  const router = useRouter()
  const { toast } = useToast()
  const pipelines = usePipelines()
  const companies = useCompanies()
  const createDeal = useCreateDeal()
  const createPerson = useCreateContact()
  const createCompany = useCreateCompany()

  const defaultPipeline = pipelines.data?.data[0]
  const openStages = (defaultPipeline?.stages ?? []).filter((s) => s.stage_type === 'open')

  // Deal fields
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [cur, setCur] = useState('INR')
  const [stageId, setStageId] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [close, setClose] = useState('')
  // Person fields
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [email, setEmail] = useState('')
  // Company fields
  const [coName, setCoName] = useState('')
  const [coDomain, setCoDomain] = useState('')

  const busy = createDeal.isPending || createPerson.isPending || createCompany.isPending

  const submit = async () => {
    try {
      if (kind === 'deal') {
        if (!title.trim()) return
        await createDeal.mutateAsync({
          title: title.trim(),
          value_amount: value ? parseFloat(value) : 0,
          currency: cur,
          ...(stageId ? { stage_id: stageId } : {}),
          ...(defaultPipeline ? { pipeline_id: defaultPipeline.id } : {}),
          ...(companyId ? { company_id: companyId } : {}),
          ...(close ? { expected_close_date: close } : {}),
        })
        toast({ title: 'Deal created' })
        onClose()
        router.push('/crm/deals')
      } else if (kind === 'person') {
        if (!(first.trim() || last.trim() || email.trim())) return
        await createPerson.mutateAsync({
          first_name: first || undefined,
          last_name: last || undefined,
          email: email || undefined,
          company_id: companyId || undefined,
        })
        toast({ title: 'Contact created' })
        onClose()
        router.push('/crm/contacts')
      } else {
        if (!coName.trim()) return
        await createCompany.mutateAsync({ name: coName.trim(), domain: coDomain || undefined })
        toast({ title: 'Company created' })
        onClose()
        router.push('/crm/companies')
      }
    } catch (err) {
      toast({
        title: `Could not create ${kind}`,
        description: err instanceof Error ? err.message : 'Unexpected error — check the console.',
        variant: 'destructive',
      })
    }
  }

  const canSubmit =
    kind === 'deal' ? !!title.trim() : kind === 'person' ? !!(first.trim() || last.trim() || email.trim()) : !!coName.trim()

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 24px 24px' }}>
      <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 520, borderRadius: 16, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, flex: 1 }}>Quick add</span>
          <span className="t-caption">press N anywhere · ≤ 2 interactions to a deal</span>
        </div>
        <div style={{ padding: 18 }}>
          <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9, marginBottom: 14 }}>
            {KINDS.map(([k, l, ic]) => {
              const Ic = Icon[ic]
              return (
                <button key={k} onClick={() => onKind(k)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', borderRadius: 6, border: 'none', cursor: 'pointer', background: kind === k ? 'var(--surf-3)' : 'transparent', color: kind === k ? '#fff' : 'var(--text-2)', fontSize: 11.5, fontWeight: 800 }}>
                  <Ic size={13} />{l}
                </button>
              )
            })}
          </div>

          {kind === 'deal' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <div className="label">Deal title</div>
                <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bluewave — suite upgrade" style={{ width: '100%' }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit() }} />
              </div>
              <div>
                <div className="label">Value</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input t-num" value={value} onChange={(e) => setValue(e.target.value)} placeholder="12,000" style={{ flex: 1, minWidth: 0 }} />
                  <select className="input" value={cur} onChange={(e) => setCur(e.target.value)} style={{ width: 86 }}>
                    {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <div className="label">Stage</div>
                <select className="input" value={stageId} onChange={(e) => setStageId(e.target.value)} style={{ width: '100%' }}>
                  <option value="">{openStages[0]?.name ?? 'First stage'}</option>
                  {openStages.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Company</div>
                <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={{ width: '100%' }}>
                  <option value="">— none —</option>
                  {(companies.data?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Expected close</div>
                <input className="input" type="date" value={close} onChange={(e) => setClose(e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>
          )}

          {kind === 'person' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><div className="label">First name</div><input autoFocus className="input" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Asha" style={{ width: '100%' }} /></div>
              <div><div className="label">Last name</div><input className="input" value={last} onChange={(e) => setLast(e.target.value)} placeholder="Rao" style={{ width: '100%' }} /></div>
              <div style={{ gridColumn: '1/-1' }}><div className="label">Email</div><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="asha@techcorp.com" style={{ width: '100%' }} /></div>
              <div style={{ gridColumn: '1/-1' }}>
                <div className="label">Company</div>
                <select className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={{ width: '100%' }}>
                  <option value="">— none —</option>
                  {(companies.data?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
          )}

          {kind === 'company' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1/-1' }}><div className="label">Company name</div><input autoFocus className="input" value={coName} onChange={(e) => setCoName(e.target.value)} placeholder="Bluewave Analytics" style={{ width: '100%' }} /></div>
              <div style={{ gridColumn: '1/-1' }}><div className="label">Domain</div><input className="input" value={coDomain} onChange={(e) => setCoDomain(e.target.value)} placeholder="bluewave.com" style={{ width: '100%' }} /></div>
            </div>
          )}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bord)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Btn kind="ghost" size="sm" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} onClick={() => void submit()} disabled={!canSubmit || busy}>
            {busy ? 'Creating…' : `Create ${kind}`}
          </Btn>
        </div>
      </div>
    </div>
  )
}
