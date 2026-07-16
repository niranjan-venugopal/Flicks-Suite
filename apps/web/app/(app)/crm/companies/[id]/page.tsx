'use client'

import { use } from 'react'
import Link from 'next/link'
import { Btn, Icon, Pill } from '@/components/proto'
import { OwnerAv } from '@/components/crm/kit'
import { DealsCard, ActivityCard } from '@/components/crm/DetailCards'
import {
  useCompany,
  useContacts,
  useCompanyDeals,
  useCompanyActivities,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// Company 360° (C5) — profile header + people + deals +
// recent activity + details, in the proto design language.
// ─────────────────────────────────────────────────────────

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, isLoading, error } = useCompany(id)
  const people = useContacts({ company_id: id })
  const deals = useCompanyDeals(id)
  const activities = useCompanyActivities(id)
  const c = data?.data

  if (isLoading) {
    return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={20} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }
  if (error || !c) {
    return (
      <div style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Company not found</div>
        <Link href="/crm/companies"><Btn kind="secondary" size="sm">Back to companies</Btn></Link>
      </div>
    )
  }

  const contacts = people.data?.data ?? []

  return (
    <div style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 24px 64px' }}>
      <Link href="/crm/companies" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 9, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 800, marginBottom: 16 }}>
        <Icon.arrowL size={14} /> Companies
      </Link>

      {/* Header */}
      <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(62,123,250,.14)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon.building size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <span className="t-h2" style={{ fontSize: 20 }}>{c.name}</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {c.domain && <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--blue)', textDecoration: 'none' }}><Icon.globe size={13} />{c.domain}</a>}
            {c.industry && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>{c.industry}</span>}
            {[c.city, c.country_code].filter(Boolean).length > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}><Icon.pin size={13} />{[c.city, c.country_code].filter(Boolean).join(', ')}</span>
            )}
            {c.source && <Pill>{c.source.replace(/_/g, ' ')}</Pill>}
          </div>
        </div>
        {c.phone && <a href={`tel:${c.phone}`}><Btn kind="secondary" size="sm" icon={<Icon.phone size={13} />}>Call</Btn></a>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <DealsCard deals={deals.data?.data ?? []} base={deals.data?.base_currency ?? 'INR'} loading={deals.isLoading} />
          <ActivityCard activities={activities.data?.data ?? []} loading={activities.isLoading} />
        </div>

        {/* People */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', alignSelf: 'flex-start' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon.people size={15} style={{ color: 'var(--green)' }} />
            <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>People</span>
            <span className="t-mute" style={{ fontSize: 11 }}>{people.data?.pagination.total ?? contacts.length}</span>
          </div>
          {contacts.length === 0 ? (
            <div className="t-mute" style={{ padding: 18, fontSize: 12.5 }}>No contacts linked yet.</div>
          ) : (
            contacts.map((p, i) => (
              <Link key={p.id} href={`/crm/contacts/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 18px', borderBottom: i < contacts.length - 1 ? '1px solid var(--bord)' : 'none', textDecoration: 'none', color: 'inherit' }}>
                <OwnerAv name={p.display_name ?? p.email ?? '?'} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800 }}>{p.display_name ?? p.email}</div>
                  <div className="t-mute" style={{ fontSize: 10.5 }}>{[p.title, p.email].filter(Boolean).join(' · ')}</div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
