'use client'

import type { EmployeeDetail } from '@/lib/api/queries/use-employees'

// Shared read-only display primitives for employee details — used by the
// employee 360° page and the onboarding review dialog (pure extraction from
// the page, zero behavior change).

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function fmtAddress(a: EmployeeDetail['currentAddress']): string {
  if (!a) return '—'
  const parts = [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(
    Boolean,
  )
  return parts.length ? parts.join(', ') : '—'
}

export function fmtPhone(p: string | null | undefined): string {
  return p && p.trim() ? p : '—'
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="t-h3" style={{ marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  )
}

export function Grid({ cols, children }: { cols: 2 | 3; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: cols === 3 ? '1fr 1fr 1fr' : '1fr 1fr',
        gap: 18,
      }}
    >
      {children}
    </div>
  )
}

export function Field({
  label,
  value,
  hint,
  mono,
  capitalize,
  span,
}: {
  label: string
  value: string
  hint?: string
  mono?: boolean
  capitalize?: boolean
  span?: 2
}) {
  return (
    <div style={{ gridColumn: span === 2 ? 'span 2' : 'auto' }}>
      <div
        className="t-caption"
        style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 4 }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--text)',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          textTransform: capitalize ? 'capitalize' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
      {hint && (
        <div className="t-mute" style={{ fontSize: 11, marginTop: 3 }}>
          {hint}
        </div>
      )}
    </div>
  )
}
