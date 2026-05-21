'use client'

import { Loader2 } from 'lucide-react'
import { Icon, Pill, SectionHead } from '@/components/proto'
import { useFamCohorts } from '@/lib/api/queries/use-fam'
import { timeAgo } from '@/lib/utils'

export default function FamCohortsPage() {
  const cohorts = useFamCohorts()
  const rows = cohorts.data?.data ?? []

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Beta cohorts"
          sub={`${rows.length} cohort${rows.length === 1 ? '' : 's'} configured. Used by feature flags to target rollouts.`}
          right={<Pill tone="purple" dot>Sprint 3 · C5</Pill>}
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {cohorts.isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
              <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12.5 }}>
              No cohorts yet. Create one to bundle tenants for staged rollouts.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map((c) => (
                <li
                  key={c.id}
                  style={{
                    display: 'flex',
                    gap: 14,
                    padding: '16px 18px',
                    borderBottom: '1px solid var(--bord)',
                    alignItems: 'flex-start',
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      background: 'var(--surf-2)',
                      border: '1px solid var(--bord)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-2)',
                    }}
                  >
                    <Icon.tag size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 800 }}>{c.name}</div>
                      <Pill tone="blue" dot>{c.tenantCount} tenants</Pill>
                    </div>
                    {c.description && (
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginTop: 4, lineHeight: 1.5 }}>
                        {c.description}
                      </div>
                    )}
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginTop: 6 }}>
                      Created {timeAgo(c.createdAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, fontSize: 11.5, color: 'var(--text-mute)' }}>
          <Icon.info size={12} style={{ display: 'inline-block', marginRight: 6, verticalAlign: '-1px' }} />
          Cohorts are read-only here for now; the inline editor lands as a follow-up. Mutations work via the existing PUT /api/v1/fam/cohorts endpoint.
        </div>
      </div>
    </div>
  )
}
