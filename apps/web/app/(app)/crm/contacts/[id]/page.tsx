'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Btn, Icon, Pill } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { OwnerAv } from '@/components/crm/kit'
import { DealsCard, ActivityCard } from '@/components/crm/DetailCards'
import {
  useContact,
  useCompany,
  useContactDeals,
  useContactActivities,
  useDeleteContact,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// Contact 360° (C4) — profile header + open deals + recent
// activity + details, in the proto design language.
// ─────────────────────────────────────────────────────────

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const deleteContact = useDeleteContact()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const { data, isLoading, error } = useContact(id)
  const p = data?.data
  const company = useCompany(p?.company_id ?? null)
  const deals = useContactDeals(id)
  const activities = useContactActivities(id)

  if (isLoading) {
    return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }
  if (error || !p) {
    return (
      <div style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Contact not found</div>
        <Link href="/crm/contacts"><Btn kind="secondary" size="sm">Back to contacts</Btn></Link>
      </div>
    )
  }

  const name = p.display_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? p.email ?? '—'

  return (
    <div style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 24px 64px' }}>
      <Link href="/crm/contacts" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 9, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 800, marginBottom: 16 }}>
        <Icon.arrowL size={14} /> Contacts
      </Link>

      {/* Header */}
      <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <OwnerAv name={name} size={48} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span className="t-h2" style={{ fontSize: 20 }}>{name}</span>
            {p.email_do_not_contact && <Pill tone="coral" icon={<Icon.warn size={10} />}>Do not contact</Pill>}
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {p.title && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>{p.title}</span>}
            {p.company_id && (
              <Link href={`/crm/companies/${p.company_id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}>
                <Icon.building size={13} />{company.data?.data.name ?? 'View company'}
              </Link>
            )}
            {p.source && <Pill>{p.source.replace(/_/g, ' ')}</Pill>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {p.email && <a href={`mailto:${p.email}`}><Btn kind="secondary" size="sm" icon={<Icon.mail size={13} />}>Email</Btn></a>}
          {p.phone && <a href={`tel:${p.phone}`}><Btn kind="secondary" size="sm" icon={<Icon.phone size={13} />}>Call</Btn></a>}
          <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} title="Delete — Manager and above"
            disabled={deleteContact.isPending} onClick={() => setConfirmingDelete(true)} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete contact"
        danger
        body={`Delete ${name}? Their deals and activity history are kept.`}
        confirmLabel="Delete contact"
        loading={deleteContact.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => deleteContact.mutate(p.id, { onSuccess: () => router.push('/crm/contacts') })}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <DealsCard deals={deals.data?.data ?? []} base={deals.data?.base_currency ?? 'INR'} loading={deals.isLoading} />
          <ActivityCard activities={activities.data?.data ?? []} loading={activities.isLoading} />
        </div>
        <DetailsCard person={p} companyName={company.data?.data.name} />
      </div>
    </div>
  )
}

function DetailsCard({ person, companyName }: { person: import('@/lib/api/queries/use-crm').DirectoryPerson; companyName?: string }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignSelf: 'flex-start' }}>
      <div className="t-caption">Details</div>
      <DetailRow icon={<Icon.mail size={13} />} label="Email" value={person.email} />
      <DetailRow icon={<Icon.phone size={13} />} label="Phone" value={person.phone} />
      {person.company_id && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
          <span className="t-mute" style={{ width: 74, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon.building size={13} />Company</span>
          <Link href={`/crm/companies/${person.company_id}`} style={{ color: 'var(--blue)', fontWeight: 700, textDecoration: 'none' }}>{companyName ?? 'View company'}</Link>
        </div>
      )}
      <DetailRow icon={<Icon.tag size={13} />} label="Source" value={person.source?.replace(/_/g, ' ')} />
      {person.email_do_not_contact && (
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--coral)' }}>
          Do-not-contact{person.email_do_not_contact_reason ? ` · ${person.email_do_not_contact_reason}` : ''}
        </div>
      )}
    </div>
  )
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
      <span className="t-mute" style={{ width: 74, display: 'inline-flex', gap: 6, alignItems: 'center' }}>{icon}{label}</span>
      <span style={{ fontWeight: 600 }}>{value || '—'}</span>
    </div>
  )
}
