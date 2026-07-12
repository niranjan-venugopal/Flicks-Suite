'use client'

import { use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Btn, Pill, Avatar } from '@/components/proto'
import { useCompany, useContacts } from '@/lib/api/queries/use-crm'

/**
 * Company 360° (C5) — Sprint 25 ships profile + people. Open deals, the
 * invoicing block, and the unified timeline arrive with deals/activities.
 */
export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, isLoading, error } = useCompany(id)
  const people = useContacts({ company_id: id })
  const c = data?.data

  if (isLoading) {
    return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Loader2 className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
  }
  if (error || !c) {
    return (
      <div style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="t-h3" style={{ marginBottom: 8 }}>Company not found</div>
        <Link href="/crm/companies"><Btn kind="secondary" size="sm">Back to companies</Btn></Link>
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px 64px', maxWidth: 900, margin: '0 auto' }}>
      <Link href="/crm/companies" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-mute)', textDecoration: 'none', fontSize: 12.5, marginBottom: 14 }}>
        <ArrowLeft size={14} /> Companies
      </Link>
      <div className="card" style={{ padding: 22, display: 'flex', gap: 16, alignItems: 'center' }}>
        <Avatar name={c.name} size="lg" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{c.name}</div>
          <div className="t-mute" style={{ fontSize: 13 }}>
            {[c.domain, c.industry, [c.city, c.country_code].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No details yet'}
          </div>
        </div>
        {c.source && <Pill>{c.source.replace(/_/g, ' ')}</Pill>}
      </div>

      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <div className="t-caption" style={{ marginBottom: 10 }}>People ({people.data?.pagination.total ?? 0})</div>
        {(people.data?.data ?? []).length === 0 ? (
          <p className="t-mute" style={{ fontSize: 13 }}>No contacts linked to this company yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {people.data!.data.map((p) => (
              <Link key={p.id} href={`/crm/contacts/${p.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--surf-1)', textDecoration: 'none', color: 'inherit' }}>
                <Avatar name={p.display_name ?? p.email ?? '?'} size="sm" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{p.display_name ?? p.email}</div>
                  <div className="t-mute" style={{ fontSize: 11.5 }}>{[p.title, p.email].filter(Boolean).join(' · ')}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
