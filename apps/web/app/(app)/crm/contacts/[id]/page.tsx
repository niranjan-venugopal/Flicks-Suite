'use client'

import { use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2, Mail, Phone } from 'lucide-react'
import { Btn, Pill } from '@/components/proto'
import { RowPresenceAvatar } from '@/components/presence/RowPresence'
import { useContact, useCompany } from '@/lib/api/queries/use-crm'

/**
 * Contact 360° (C4) — Sprint 25 ships profile + company link. Open deals,
 * timeline, emails, and activities arrive with later sprints.
 */
export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, isLoading, error } = useContact(id)
  const p = data?.data
  const company = useCompany(p?.company_id ?? null)

  if (isLoading) {
    return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }
  if (error || !p) {
    return (
      <div style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Contact not found</div>
        <Link href="/crm/contacts"><Btn kind="secondary" size="sm">Back to contacts</Btn></Link>
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px 64px', maxWidth: 900, margin: '0 auto' }}>
      <Link href="/crm/contacts" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-mute)', textDecoration: 'none', fontSize: 12.5, marginBottom: 14 }}>
        <ArrowLeft size={14} /> Contacts
      </Link>
      <div className="card" style={{ padding: 22, display: 'flex', gap: 16, alignItems: 'center' }}>
        <RowPresenceAvatar name={p.display_name ?? p.email ?? '?'} userId={p.owner_user_id} size={48} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{p.display_name ?? '—'}</div>
          <div className="t-mute" style={{ fontSize: 13 }}>
            {[p.title, company.data?.data.name].filter(Boolean).join(' · ') || 'No title'}
          </div>
        </div>
        {p.source && <Pill>{p.source.replace(/_/g, ' ')}</Pill>}
      </div>

      <div className="card" style={{ padding: 20, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="t-caption">Details</div>
        <Row icon={<Mail size={14} />} label="Email" value={p.email} />
        <Row icon={<Phone size={14} />} label="Phone" value={p.phone} />
        {p.company_id && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span className="t-mute" style={{ width: 70 }}>Company</span>
            <Link href={`/crm/companies/${p.company_id}`} style={{ color: 'var(--blue)', fontWeight: 700 }}>
              {company.data?.data.name ?? 'View company'}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
      <span className="t-mute" style={{ width: 70, display: 'flex', alignItems: 'center', gap: 6 }}>{icon}{label}</span>
      <span>{value || '—'}</span>
    </div>
  )
}
