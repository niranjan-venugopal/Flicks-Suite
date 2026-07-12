'use client'

import Link from 'next/link'
import { Users, Building2, Kanban, ArrowRight } from 'lucide-react'
import { SectionHead } from '@/components/proto'
import { useCompanies, useContacts, useForecast } from '@/lib/api/queries/use-crm'

function fmt(n: number, cur: string) {
  return `${cur === 'INR' ? '₹' : cur + ' '}${Math.round(n).toLocaleString('en-IN')}`
}

/**
 * CRM Overview (C1) — Sprint 25 ships the directory entry points; the full
 * dashboard (pipeline value, tasks today, rotting deals, timeline) lands with
 * deals + activities in later sprints.
 */
export default function CrmOverviewPage() {
  const companies = useCompanies()
  const contacts = useContacts()
  const forecast = useForecast()
  const f = forecast.data?.data
  const base = f?.base_currency ?? 'INR'

  const tiles = [
    { href: '/crm/deals', label: 'Open pipeline', icon: Kanban, count: f ? fmt(f.open_value, base) : undefined, sub: f ? `${f.open_count} deals · weighted ${fmt(f.weighted_value, base)}` : undefined },
    { href: '/crm/contacts', label: 'Contacts', icon: Users, count: contacts.data?.pagination.total, sub: 'total' },
    { href: '/crm/companies', label: 'Companies', icon: Building2, count: companies.data?.pagination.total, sub: 'total' },
  ]

  return (
    <div style={{ padding: '28px 32px 64px' }}>
      <SectionHead title="CRM" sub="Your sales directory — contacts, companies, and (soon) deals." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, marginTop: 18 }}>
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14, textDecoration: 'none', color: 'inherit' }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--surf-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <t.icon size={20} style={{ color: 'var(--blue)' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{t.count ?? '—'}</div>
              <div className="t-mute" style={{ fontSize: 12 }}>{t.label}{t.sub ? ` · ${t.sub}` : ''}</div>
            </div>
            <ArrowRight size={16} style={{ color: 'var(--text-mute)' }} />
          </Link>
        ))}
      </div>
      <div className="card" style={{ marginTop: 18, padding: 20 }}>
        <div className="t-caption" style={{ marginBottom: 6 }}>Coming soon</div>
        <p className="t-mute" style={{ fontSize: 13 }}>
          Deals kanban, leads inbox, activities & follow-ups, email sequences, workflows, and reports
          arrive in the next CRM sprints. Your contacts and companies are the shared directory they all build on.
        </p>
      </div>
    </div>
  )
}
