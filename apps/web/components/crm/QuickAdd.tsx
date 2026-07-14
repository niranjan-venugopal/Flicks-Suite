'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import { APIError } from '@/lib/api/client'
import { useQuickAdd, type QuickAddKind } from '@/lib/stores/quick-add.store'
import {
  usePipelines,
  useCompanies,
  useContacts,
  useCreateDeal,
  useCreateContact,
  useCreateCompany,
  useAddDealPerson,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C7 — New-deal quick-add. The three tabs are SECTIONS of one
// linked flow, not separate create actions: Deal holds the
// deal fields, Person and Company keep their own fields (or a
// link-existing search), and ONE "Create deal" submits the
// lot — deal→company, deal→primary contact, contact→company,
// deal participant, all wired in a single click.
// ─────────────────────────────────────────────────────────

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED']

const TABS: Array<[QuickAddKind, string, keyof typeof Icon]> = [
  ['deal', 'Deal', 'target'],
  ['person', 'Person', 'user'],
  ['company', 'Company', 'building'],
]

/** An existing directory record chosen in a link-search. */
interface LinkedRef {
  id: string
  label: string
  sub?: string | null
}

export function QuickAddGlobal() {
  const { open, kind, openWith, close } = useQuickAdd()

  // N opens the new-deal flow anywhere in CRM (not while typing).
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
  return <QuickAddModal initialTab={kind} onClose={close} />
}

function QuickAddModal({ initialTab, onClose }: { initialTab: QuickAddKind; onClose: () => void }) {
  const router = useRouter()
  const { toast } = useToast()
  const pipelines = usePipelines()
  const createDeal = useCreateDeal()
  const createPerson = useCreateContact()
  const createCompany = useCreateCompany()
  const addDealPerson = useAddDealPerson()
  const [tab, setTab] = useState<QuickAddKind>(initialTab)
  const [submitting, setSubmitting] = useState(false)

  const defaultPipeline = pipelines.data?.data[0]
  const openStages = (defaultPipeline?.stages ?? []).filter((s) => s.stage_type === 'open')

  // Deal section
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [cur, setCur] = useState('INR')
  const [stageId, setStageId] = useState('')
  const [close, setClose] = useState('')
  // Person section — link an existing contact OR fill the fields for a new one.
  const [personRef, setPersonRef] = useState<LinkedRef | null>(null)
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [email, setEmail] = useState('')
  // Company section — link an existing company OR fill the fields for a new one.
  const [companyRef, setCompanyRef] = useState<LinkedRef | null>(null)
  const [coName, setCoName] = useState('')
  const [coDomain, setCoDomain] = useState('')

  const personFilled = !!personRef || !!(first.trim() || last.trim() || email.trim())
  const companyFilled = !!companyRef || !!coName.trim()
  const busy = submitting || createDeal.isPending || createPerson.isPending || createCompany.isPending

  /** One submit: company → contact → deal, everything linked. */
  const submit = async () => {
    if (!title.trim()) return
    setSubmitting(true)
    try {
      // 1 — company: linked, or created from the Company tab's fields.
      let companyId = companyRef?.id
      if (!companyId && coName.trim()) {
        const created = await createCompany.mutateAsync({ name: coName.trim(), domain: coDomain.trim() || undefined })
        companyId = created.data.id
      }

      // 2 — contact: linked, or created from the Person tab's fields
      //     (attached to whatever company the Company tab produced).
      let personId = personRef?.id
      if (!personId && (first.trim() || last.trim() || email.trim())) {
        try {
          const created = await createPerson.mutateAsync({
            first_name: first.trim() || undefined,
            last_name: last.trim() || undefined,
            email: email.trim() || undefined,
            company_id: companyId,
          })
          personId = created.data.id
        } catch (err) {
          // Known email → link the existing contact instead of failing the deal.
          const dup = err instanceof APIError ? (err.data as { code?: string; existing?: { id?: string; display_name?: string } }) : undefined
          if (dup?.code === 'DUPLICATE_EMAIL' && dup.existing?.id) {
            personId = dup.existing.id
            toast({ title: 'Linked existing contact', description: `${dup.existing.display_name ?? email} already exists — linked instead of duplicating.` })
          } else {
            throw err
          }
        }
      }

      // 3 — the deal, wired to both.
      const deal = await createDeal.mutateAsync({
        title: title.trim(),
        value_amount: value ? parseFloat(value.replace(/,/g, '')) : 0,
        currency: cur,
        ...(stageId ? { stage_id: stageId } : {}),
        ...(defaultPipeline ? { pipeline_id: defaultPipeline.id } : {}),
        ...(companyId ? { company_id: companyId } : {}),
        ...(personId ? { primary_person_id: personId } : {}),
        ...(close ? { expected_close_date: close } : {}),
      })

      // 4 — the contact also shows on the deal's People tab (best-effort).
      if (personId) {
        try {
          await addDealPerson.mutateAsync({ dealId: deal.data.id, body: { person_id: personId, role: 'primary contact' } })
        } catch { /* participant listing is cosmetic; the primary link is set */ }
      }

      toast({
        title: 'Deal created',
        description: [
          companyId ? (companyRef ? 'company linked' : 'company created') : null,
          personId ? (personRef ? 'contact linked' : 'contact created') : null,
        ].filter(Boolean).join(' · ') || undefined,
      })
      onClose()
      router.push('/crm/deals')
    } catch (err) {
      toast({ title: 'Could not create deal', description: err instanceof Error ? err.message : 'Unexpected error', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  // Footer caption — say exactly what one click will do.
  const outcome = [
    'creates deal',
    companyFilled ? (companyRef ? 'links company' : 'creates company') : null,
    personFilled ? (personRef ? 'links contact' : 'creates contact') : null,
  ].filter(Boolean).join(' · ')

  const sectionDone: Record<QuickAddKind, boolean> = { deal: !!title.trim(), person: personFilled, company: companyFilled }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '10vh 24px 24px' }}>
      <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 560, borderRadius: 16, padding: 0, overflow: 'visible' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, flex: 1 }}>New deal</span>
          <span className="t-caption">press N anywhere · all three tabs land in one click</span>
        </div>
        <div style={{ padding: 18 }}>
          <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9, marginBottom: 14 }}>
            {TABS.map(([k, l, ic]) => {
              const Ic = Icon[ic]
              return (
                <button key={k} onClick={() => setTab(k)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 0', borderRadius: 6, border: 'none', cursor: 'pointer', background: tab === k ? 'var(--surf-3)' : 'transparent', color: tab === k ? '#fff' : 'var(--text-2)', fontSize: 11.5, fontWeight: 800, position: 'relative' }}>
                  <Ic size={13} />{l}
                  {sectionDone[k] && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', marginLeft: 2 }} />}
                </button>
              )
            })}
          </div>

          {tab === 'deal' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <div className="label">Deal title</div>
                <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bluewave — suite upgrade" style={{ width: '100%' }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && !busy) void submit() }} />
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
              <div style={{ gridColumn: '1/-1' }}>
                <div className="label">Expected close</div>
                <input className="input" type="date" value={close} onChange={(e) => setClose(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="t-caption" style={{ gridColumn: '1/-1' }}>
                Add the customer on the <b style={{ color: 'var(--text-2)' }}>Person</b> and <b style={{ color: 'var(--text-2)' }}>Company</b> tabs — everything is created and linked together when you hit Create deal.
              </div>
            </div>
          )}

          {tab === 'person' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <PersonLinkSearch value={personRef} onChange={setPersonRef} />
              </div>
              {!personRef && (
                <>
                  <div className="t-caption" style={{ gridColumn: '1/-1' }}>…or enter a new contact — created with the deal:</div>
                  <div><div className="label">First name</div><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Asha" style={{ width: '100%' }} /></div>
                  <div><div className="label">Last name</div><input className="input" value={last} onChange={(e) => setLast(e.target.value)} placeholder="Rao" style={{ width: '100%' }} /></div>
                  <div style={{ gridColumn: '1/-1' }}><div className="label">Email <span style={{ color: 'var(--text-faint)' }}>· optional, de-duped</span></div><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="asha@techcorp.com" style={{ width: '100%' }} /></div>
                  <div className="t-caption" style={{ gridColumn: '1/-1' }}>The new contact is attached to whatever the Company tab holds.</div>
                </>
              )}
            </div>
          )}

          {tab === 'company' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <CompanyLinkSearch value={companyRef} onChange={setCompanyRef} />
              </div>
              {!companyRef && (
                <>
                  <div className="t-caption" style={{ gridColumn: '1/-1' }}>…or enter a new company — created with the deal:</div>
                  <div style={{ gridColumn: '1/-1' }}><div className="label">Company name</div><input className="input" value={coName} onChange={(e) => setCoName(e.target.value)} placeholder="Bluewave Analytics" style={{ width: '100%' }} /></div>
                  <div style={{ gridColumn: '1/-1' }}><div className="label">Domain</div><input className="input" value={coDomain} onChange={(e) => setCoDomain(e.target.value)} placeholder="bluewave.com" style={{ width: '100%' }} /></div>
                </>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bord)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="t-caption" style={{ flex: 1 }}>{outcome}</span>
          <Btn kind="ghost" size="sm" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} onClick={() => void submit()} disabled={!title.trim() || busy}
            title={title.trim() ? undefined : 'Give the deal a title on the Deal tab'}>
            {busy ? 'Creating…' : 'Create deal'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ─── Link-existing search (shared by the Person and Company tabs) ─────────────

function PersonLinkSearch({ value, onChange }: { value: LinkedRef | null; onChange: (v: LinkedRef | null) => void }) {
  const [q, setQ] = useState('')
  const contacts = useContacts(q ? { q } : undefined)
  const rows = (contacts.data?.data ?? []).map((p) => ({ id: p.id, label: p.display_name ?? p.email ?? '—', sub: p.email }))
  return (
    <LinkSearchView label="Link an existing contact" placeholder="Search contacts…" value={value} onChange={onChange}
      q={q} setQ={setQ} rows={rows} icon={<Icon.user size={13} style={{ color: 'var(--text-mute)' }} />} />
  )
}

function CompanyLinkSearch({ value, onChange }: { value: LinkedRef | null; onChange: (v: LinkedRef | null) => void }) {
  const [q, setQ] = useState('')
  const companies = useCompanies(q || undefined)
  const rows = (companies.data?.data ?? []).map((c) => ({ id: c.id, label: c.name, sub: c.domain }))
  return (
    <LinkSearchView label="Link an existing company" placeholder="Search companies…" value={value} onChange={onChange}
      q={q} setQ={setQ} rows={rows} icon={<Icon.building size={13} style={{ color: 'var(--text-mute)' }} />} />
  )
}

function LinkSearchView({ label, placeholder, value, onChange, q, setQ, rows, icon }: {
  label: string
  placeholder: string
  value: LinkedRef | null
  onChange: (v: LinkedRef | null) => void
  q: string
  setQ: (q: string) => void
  rows: LinkedRef[]
  icon?: React.ReactNode
}) {
  const [focus, setFocus] = useState(false)
  const shown = rows.slice(0, 6)

  if (value) {
    return (
      <div>
        <div className="label">{label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 10px', borderRadius: 8, background: 'var(--surf-1)', border: '1px solid var(--bord-2)' }}>
          <Pill tone="blue">linked</Pill>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {value.label}{value.sub ? <span className="t-mute" style={{ fontSize: 10.5 }}> · {value.sub}</span> : null}
          </span>
          <button onClick={() => onChange(null)} style={{ background: 'none', border: 'none', color: 'var(--text-mute)', cursor: 'pointer', display: 'flex' }}><Icon.x size={13} /></button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ position: 'relative' }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
          placeholder={placeholder} style={{ width: '100%' }} />
        {focus && (shown.length > 0 || !!q.trim()) && (
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 80, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 4, boxShadow: '0 16px 40px rgba(0,0,0,.5)', maxHeight: 210, overflowY: 'auto' }}>
            {shown.map((r) => (
              <button key={r.id} onMouseDown={(e) => { e.preventDefault(); onChange(r); setQ('') }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surf-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                {icon}
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>{r.label}</span>
                {r.sub && <span className="t-mute" style={{ fontSize: 10.5 }}>{r.sub}</span>}
              </button>
            ))}
            {shown.length === 0 && <div className="t-mute" style={{ padding: '8px 9px', fontSize: 11.5 }}>No matches — use the fields below to create new.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
