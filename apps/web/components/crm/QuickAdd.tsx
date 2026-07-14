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
// C7 — Global quick-add. The DEAL tab is the flagship flow:
// deal + company + contact land in ONE submit — each picker
// links an existing record by search or creates a new one
// inline, and everything ends up connected (deal→company,
// deal→primary contact, contact→company, deal participant).
// ─────────────────────────────────────────────────────────

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED']

const KINDS: Array<[QuickAddKind, string, keyof typeof Icon]> = [
  ['deal', 'Deal', 'target'],
  ['person', 'Person', 'user'],
  ['company', 'Company', 'building'],
]

/** A picker selection: an existing record, or a new one to create on submit. */
type Linked = { id: string; label: string; isNew: false } | { name: string; isNew: true }

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
  const createDeal = useCreateDeal()
  const createPerson = useCreateContact()
  const createCompany = useCreateCompany()
  const addDealPerson = useAddDealPerson()
  const [submitting, setSubmitting] = useState(false)

  const defaultPipeline = pipelines.data?.data[0]
  const openStages = (defaultPipeline?.stages ?? []).filter((s) => s.stage_type === 'open')

  // Deal fields
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [cur, setCur] = useState('INR')
  const [stageId, setStageId] = useState('')
  const [close, setClose] = useState('')
  const [company, setCompany] = useState<Linked | null>(null)
  const [person, setPerson] = useState<Linked | null>(null)
  const [personEmail, setPersonEmail] = useState('')
  // Person tab fields
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [email, setEmail] = useState('')
  // Company tab fields
  const [coName, setCoName] = useState('')
  const [coDomain, setCoDomain] = useState('')

  const busy = submitting || createDeal.isPending || createPerson.isPending || createCompany.isPending

  /** The flagship chain: company → contact → deal, all linked, one click. */
  const submitDeal = async () => {
    if (!title.trim()) return
    setSubmitting(true)
    try {
      // 1 — company: link existing or create inline.
      let companyId: string | undefined
      if (company && !company.isNew) companyId = company.id
      if (company?.isNew) {
        const created = await createCompany.mutateAsync({ name: company.name })
        companyId = created.data.id
      }

      // 2 — contact: link existing or create inline (attached to the company).
      let personId: string | undefined
      if (person && !person.isNew) personId = person.id
      if (person?.isNew) {
        const parts = person.name.trim().split(/\s+/)
        try {
          const created = await createPerson.mutateAsync({
            first_name: parts[0],
            last_name: parts.slice(1).join(' ') || undefined,
            email: personEmail.trim() || undefined,
            company_id: companyId,
          })
          personId = created.data.id
        } catch (err) {
          // Known email → link the existing contact instead of failing the deal.
          const dup = err instanceof APIError ? (err.data as { code?: string; existing?: { id?: string; display_name?: string } }) : undefined
          if (dup?.code === 'DUPLICATE_EMAIL' && dup.existing?.id) {
            personId = dup.existing.id
            toast({ title: 'Linked existing contact', description: `${dup.existing.display_name ?? personEmail} already exists — linked instead of duplicating.` })
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

      // 4 — the contact also appears on the deal's People tab (best-effort).
      if (personId) {
        try {
          await addDealPerson.mutateAsync({ dealId: deal.data.id, body: { person_id: personId, role: 'primary contact' } })
        } catch { /* participant listing is cosmetic; the primary link is set */ }
      }

      toast({ title: 'Deal created', description: [company && 'company linked', person && 'contact linked'].filter(Boolean).join(' · ') || undefined })
      onClose()
      router.push('/crm/deals')
    } catch (err) {
      toast({ title: 'Could not create deal', description: err instanceof Error ? err.message : 'Unexpected error', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async () => {
    if (kind === 'deal') return submitDeal()
    try {
      if (kind === 'person') {
        if (!(first.trim() || last.trim() || email.trim())) return
        await createPerson.mutateAsync({
          first_name: first || undefined,
          last_name: last || undefined,
          email: email || undefined,
          company_id: company && !company.isNew ? company.id : undefined,
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
      toast({ title: `Could not create ${kind}`, description: err instanceof Error ? err.message : 'Unexpected error', variant: 'destructive' })
    }
  }

  const canSubmit =
    kind === 'deal' ? !!title.trim() : kind === 'person' ? !!(first.trim() || last.trim() || email.trim()) : !!coName.trim()

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '10vh 24px 24px' }}>
      <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 560, borderRadius: 16, padding: 0, overflow: 'visible' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, flex: 1 }}>Quick add</span>
          <span className="t-caption">press N anywhere · deal + company + contact in one go</span>
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
                <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bluewave — suite upgrade" style={{ width: '100%' }} />
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
                <CompanyPicker value={company} onChange={setCompany} />
              </div>
              <div>
                <PersonPicker value={person} onChange={(p) => { setPerson(p); if (!p || !p.isNew) setPersonEmail('') }} />
              </div>
              {person?.isNew && (
                <div style={{ gridColumn: '1/-1' }}>
                  <div className="label">New contact's email <span style={{ color: 'var(--text-faint)' }}>· optional, de-duped</span></div>
                  <input className="input" value={personEmail} onChange={(e) => setPersonEmail(e.target.value)} placeholder="asha@techcorp.com" style={{ width: '100%' }} />
                </div>
              )}
              <div style={{ gridColumn: '1/-1' }}>
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
              <div style={{ gridColumn: '1/-1' }}><CompanyPicker value={company} onChange={setCompany} existingOnly /></div>
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

// ─── Combo pickers: search existing OR create inline ──────────────────────────

function PickerShell({ label, hint, value, onClear, children }: {
  label: string
  hint?: string
  value: Linked | null
  onClear: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="label">{label} {hint && <span style={{ color: 'var(--text-faint)' }}>· {hint}</span>}</div>
      {value ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 10px', borderRadius: 8, background: 'var(--surf-1)', border: '1px solid var(--bord-2)' }}>
          <Pill tone={value.isNew ? 'yellow' : 'blue'}>{value.isNew ? 'new' : 'linked'}</Pill>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {value.isNew ? value.name : value.label}
          </span>
          <button onClick={onClear} style={{ background: 'none', border: 'none', color: 'var(--text-mute)', cursor: 'pointer', display: 'flex' }}><Icon.x size={13} /></button>
        </div>
      ) : children}
    </div>
  )
}

function Dropdown({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 80, background: 'rgba(18,18,30,.98)', border: '1px solid var(--bord-2)', borderRadius: 10, padding: 4, boxShadow: '0 16px 40px rgba(0,0,0,.5)', maxHeight: 210, overflowY: 'auto' }}>
      {children}
    </div>
  )
}

function OptionRow({ primary, secondary, icon, onPick }: { primary: string; secondary?: string | null; icon?: React.ReactNode; onPick: () => void }) {
  return (
    <button onMouseDown={(e) => { e.preventDefault(); onPick() }}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surf-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
      {icon}
      <span style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>{primary}</span>
      {secondary && <span className="t-mute" style={{ fontSize: 10.5 }}>{secondary}</span>}
    </button>
  )
}

export function CompanyPicker({ value, onChange, existingOnly }: { value: Linked | null; onChange: (v: Linked | null) => void; existingOnly?: boolean }) {
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState(false)
  const companies = useCompanies(q || undefined)
  const rows = (companies.data?.data ?? []).slice(0, 6)
  const exact = rows.some((c) => c.name.toLowerCase() === q.trim().toLowerCase())
  return (
    <PickerShell label="Company" hint="link or create" value={value} onClear={() => onChange(null)}>
      <div style={{ position: 'relative' }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
          placeholder="Search companies…" style={{ width: '100%' }} />
        <Dropdown open={focus && (rows.length > 0 || !!q.trim())}>
          {rows.map((c) => (
            <OptionRow key={c.id} primary={c.name} secondary={c.domain} icon={<Icon.building size={13} style={{ color: 'var(--text-mute)' }} />}
              onPick={() => { onChange({ id: c.id, label: c.name, isNew: false }); setQ('') }} />
          ))}
          {!existingOnly && q.trim() && !exact && (
            <OptionRow primary={`Create “${q.trim()}”`} icon={<Icon.plus size={13} style={{ color: 'var(--green)' }} />}
              onPick={() => { onChange({ name: q.trim(), isNew: true }); setQ('') }} />
          )}
          {rows.length === 0 && !q.trim() && <div className="t-mute" style={{ padding: '8px 9px', fontSize: 11.5 }}>Type to search…</div>}
        </Dropdown>
      </div>
    </PickerShell>
  )
}

function PersonPicker({ value, onChange }: { value: Linked | null; onChange: (v: Linked | null) => void }) {
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState(false)
  const contacts = useContacts(q ? { q } : undefined)
  const rows = (contacts.data?.data ?? []).slice(0, 6)
  const exact = rows.some((p) => (p.display_name ?? '').toLowerCase() === q.trim().toLowerCase())
  return (
    <PickerShell label="Contact person" hint="link or create" value={value} onClear={() => onChange(null)}>
      <div style={{ position: 'relative' }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
          placeholder="Search contacts…" style={{ width: '100%' }} />
        <Dropdown open={focus && (rows.length > 0 || !!q.trim())}>
          {rows.map((p) => (
            <OptionRow key={p.id} primary={p.display_name ?? p.email ?? '—'} secondary={p.email} icon={<Icon.user size={13} style={{ color: 'var(--text-mute)' }} />}
              onPick={() => { onChange({ id: p.id, label: p.display_name ?? p.email ?? '—', isNew: false }); setQ('') }} />
          ))}
          {q.trim() && !exact && (
            <OptionRow primary={`Create “${q.trim()}”`} icon={<Icon.plus size={13} style={{ color: 'var(--green)' }} />}
              onPick={() => { onChange({ name: q.trim(), isNew: true }); setQ('') }} />
          )}
          {rows.length === 0 && !q.trim() && <div className="t-mute" style={{ padding: '8px 9px', fontSize: 11.5 }}>Type to search…</div>}
        </Dropdown>
      </div>
    </PickerShell>
  )
}
