'use client'

import { Loader2 } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useFamCohorts } from '@/lib/api/queries/use-fam'
import { timeAgo } from '@/lib/utils'

// One tone per card position so the gradient header has visual variety.
const TONE_BY_INDEX = ['green', 'blue', 'purple', 'yellow', 'coral'] as const

export default function FamCohortsPage() {
  const cohorts = useFamCohorts()
  const rows = cohorts.data?.data ?? []

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Beta cohorts"
          sub="Group tenants for staged rollouts, announcements, and per-cohort metrics."
          right={
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
              New cohort
            </Btn>
          }
        />

        {cohorts.isLoading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
          </div>
        ) : rows.length === 0 ? (
          <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12.5 }}>
            No cohorts yet. Create one to bundle tenants for staged rollouts.
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginBottom: 14 }}>
              {rows.map((c, i) => {
                const tone = TONE_BY_INDEX[i % TONE_BY_INDEX.length]
                return (
                  <div key={c.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <div
                      style={{
                        padding: '18px 22px',
                        borderBottom: '1px solid var(--bord)',
                        background: `linear-gradient(135deg, var(--${tone})22, transparent)`,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
                            {c.name}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 3 }}>
                            Created {timeAgo(c.createdAt)}
                          </div>
                        </div>
                        <Btn kind="ghost" size="sm" icon={<Icon.more size={13} />} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
                        {c.description ?? 'No description.'}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '14px 22px',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: 10,
                        borderBottom: '1px solid var(--bord)',
                      }}
                    >
                      <KpiTile label="Tenants" value={c.tenantCount} />
                      <KpiTile label="Active flags" value="—" hint="Wires when flag-cohort linking lands" />
                      <KpiTile label="Avg health" value="—" tone="green" hint="From tenant_health_snapshots" />
                    </div>

                    <div style={{ padding: '14px 22px' }}>
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: 'var(--text-faint)',
                          letterSpacing: '.06em',
                          textTransform: 'uppercase',
                          marginBottom: 6,
                        }}
                      >
                        Tenants in cohort
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                        {c.tenantIds.slice(0, 6).map((id) => (
                          <span
                            key={id}
                            style={{
                              padding: '4px 8px',
                              background: 'var(--surf-2)',
                              border: '1px solid var(--bord-2)',
                              borderRadius: 6,
                              fontSize: 10.5,
                              fontWeight: 800,
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--blue)',
                            }}
                          >
                            {id.slice(0, 8)}
                          </span>
                        ))}
                        {c.tenantIds.length === 0 && (
                          <span style={{ fontSize: 11.5, color: 'var(--text-mute)' }}>
                            No tenants yet.
                          </span>
                        )}
                        {c.tenantIds.length > 6 && (
                          <span style={{ fontSize: 11, color: 'var(--text-mute)', fontWeight: 700 }}>
                            +{c.tenantIds.length - 6} more
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Btn kind="secondary" size="sm" icon={<Icon.send size={12} />}>
                          Announce
                        </Btn>
                        <Btn kind="ghost" size="sm" icon={<Icon.people size={12} />}>
                          View tenants
                        </Btn>
                        <div style={{ flex: 1 }} />
                        <Btn kind="ghost" size="sm" icon={<Icon.cog size={12} />}>
                          Edit
                        </Btn>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div
                style={{
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--bord)',
                  fontSize: 12,
                  fontWeight: 800,
                  color: 'var(--text-2)',
                }}
              >
                Per-cohort metrics
                <span style={{ marginLeft: 8, color: 'var(--text-mute)', fontWeight: 600 }}>
                  · Compare KPIs across cohorts
                </span>
              </div>
              <table className="tbl" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Cohort</th>
                    <th style={{ textAlign: 'right' }}>Tenants</th>
                    <th style={{ textAlign: 'right' }}>Avg seats</th>
                    <th style={{ textAlign: 'right' }}>Activation</th>
                    <th style={{ textAlign: 'right' }}>Retention M3</th>
                    <th style={{ textAlign: 'right' }}>NPS</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 800 }}>{c.name}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{c.tenantCount}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-mute)' }}>—</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-mute)' }}>—</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-mute)' }}>—</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-mute)' }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div
                style={{
                  padding: '10px 18px',
                  background: 'var(--surf-1)',
                  borderTop: '1px solid var(--bord)',
                  fontSize: 11.5,
                  color: 'var(--text-mute)',
                }}
              >
                <Icon.info size={12} style={{ display: 'inline-block', marginRight: 6, verticalAlign: '-1px' }} />
                Activation / retention / NPS land when we ship the survey + product-event pipeline.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function KpiTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: number | string
  tone?: 'green' | 'blue' | 'purple' | 'yellow' | 'coral'
  hint?: string
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          color: 'var(--text-faint)',
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          color: tone ? `var(--${tone})` : '#fff',
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginTop: 2 }}>
          {hint}
        </div>
      )}
    </div>
  )
}
