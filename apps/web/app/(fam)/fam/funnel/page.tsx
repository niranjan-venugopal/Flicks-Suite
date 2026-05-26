'use client'

import { Loader2 } from 'lucide-react'
import { Icon, SectionHead } from '@/components/proto'
import { useFamFunnel } from '@/lib/api/queries/use-fam'

export default function FamFunnelPage() {
  const funnel = useFamFunnel()
  const d = funnel.data
  const maxCount = (d?.stages[0]?.count ?? 0) || 1

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 900, margin: '0 auto' }}>
        <SectionHead
          title="Signup funnel"
          sub="Where new customers drop off between signup and first activity."
        />

        <div className="card" style={{ padding: 24 }}>
          {funnel.isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
              <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 14 }}>
              {(d?.stages ?? []).map((s, i, arr) => {
                const width = Math.max(8, (s.count / maxCount) * 100)
                const prev = i > 0 ? arr[i - 1].count : s.count
                const dropOff = prev > 0 ? Math.round(((prev - s.count) / prev) * 100) : 0
                return (
                  <li key={s.id} style={{ display: 'grid', gridTemplateColumns: '220px 1fr 120px', gap: 14, alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{s.label}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                        {i === 0 ? 'Start' : `${dropOff}% drop from previous`}
                      </div>
                    </div>
                    <div
                      style={{
                        position: 'relative',
                        height: 36,
                        borderRadius: 8,
                        background: 'var(--surf-1)',
                        border: '1px solid var(--bord)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          width: `${width}%`,
                          background: 'linear-gradient(90deg, var(--blue) 0%, var(--purple) 100%)',
                          opacity: 0.85,
                        }}
                      />
                      <div
                        style={{
                          position: 'relative',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          height: '100%',
                          padding: '0 12px',
                          fontSize: 12,
                          fontWeight: 800,
                          color: '#fff',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {s.count}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 14 }}>
                        {s.rate.toFixed(1)}%
                      </span>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>of signups</div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, fontSize: 11.5, color: 'var(--text-mute)' }}>
          <Icon.info size={12} style={{ display: 'inline-block', marginRight: 6, verticalAlign: '-1px' }} />
          Stages: <strong>signed up</strong> (tenant exists) → <strong>workspace configured</strong> (≥1 location + department) → <strong>first invite sent</strong> → <strong>first employee accepted</strong> (≥2 active memberships) → <strong>first activity</strong> (any attendance / leave / timesheet entry).
        </div>
      </div>
    </div>
  )
}
