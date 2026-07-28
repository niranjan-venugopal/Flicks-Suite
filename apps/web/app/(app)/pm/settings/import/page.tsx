'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation } from '@tanstack/react-query'
import { Btn, Icon, Pill } from '@/components/proto'
import { api } from '@/lib/api/client'
import { FEATURES } from '@/lib/feature-flags'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useToast } from '@/components/ui/use-toast'

// ─────────────────────────────────────────────────────────
// P17 — Import wizard (§14), faithful to scr-settings-pm.jsx ScrPmImport:
// 1 Source → 2 Map → 3 Dry run → 4 Results. CSV / Linear export / Jira
// Cloud export; external-id dedupe makes re-runs idempotent.
// ─────────────────────────────────────────────────────────

type Preset = 'linear' | 'jira' | 'csv'

interface ParseResult {
  file_name: string
  rows: number
  headers: Array<{ column: string; suggested: string; samples: string[] }>
  targets: readonly string[]
}
interface DryRunResult {
  rows_read: number
  will_create: number
  will_update: number
  will_skip: number
  errors: number
  preview: Array<{ row: number; action: string; title: string; reason?: string }>
}
interface RunResult {
  batch_id: string
  created: number
  updated: number
  skipped: number
  errors: Array<{ row: number; error: string }>
}

const SOURCES: Array<{ id: Preset; label: string; sub: string }> = [
  { id: 'csv', label: 'CSV', sub: 'generic mapping UI' },
  { id: 'linear', label: 'Linear', sub: 'CSV export' },
  { id: 'jira', label: 'Jira', sub: 'Cloud CSV export' },
]

function SettingsTabs({ active }: { active: string }) {
  const tabs = [
    // GitHub is parked (FEATURES.pm_github) while the connection model moves
    // to per-user OAuth — the tab returns when the flag flips.
    ...(FEATURES.pm_github ? ([['/pm/settings/github', 'GitHub']] as const) : []),
    ['/pm/settings/notifications', 'Notifications'],
    ['/pm/settings/import', 'Import'],
    ['/pm/settings/workspace', 'Workspace'],
  ] as const
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
      {tabs.map(([href, label]) => (
        <Link key={href} href={href} style={{
          padding: '5px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 800, textDecoration: 'none',
          color: href.includes(active) ? '#fff' : 'var(--text-mute)',
          background: href.includes(active) ? 'var(--surf-2)' : 'transparent',
          border: href.includes(active) ? '1px solid var(--bord-2)' : '1px solid transparent',
        }}>{label}</Link>
      ))}
    </div>
  )
}

export default function PmImportPage() {
  const role = useAuthStore((s) => s.currentUser?.role)
  const canImport = role === 'OWNER' || role === 'HR_ADMIN' || role === 'MANAGER'
  const router = useRouter()
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState(0)
  const [preset, setPreset] = useState<Preset>('linear')
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [dry, setDry] = useState<DryRunResult | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)

  const parse = useMutation({
    mutationFn: (payload: { csv: string; file_name: string }) =>
      api.post<{ data: ParseResult }>('/api/v1/pm/import/parse', payload),
    onSuccess: (r, vars) => {
      const data = r.data
      setParsed(data)
      setMapping(Object.fromEntries(data.headers.map((h) => [h.column, h.suggested])))
      setCsv(vars.csv)
      setFileName(vars.file_name)
      setStep(1)
    },
    onError: (e) => toast({ title: 'Could not read the file', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })
  const dryRun = useMutation({
    mutationFn: () => api.post<{ data: DryRunResult }>('/api/v1/pm/import/dry-run', { csv, file_name: fileName, mapping, preset, strategy: 'update' }),
    onSuccess: (r) => { setDry(r.data); setStep(2) },
    onError: (e) => toast({ title: 'Dry run failed', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })
  const run = useMutation({
    mutationFn: () => api.post<{ data: RunResult }>('/api/v1/pm/import/run', { csv, file_name: fileName, mapping, preset, strategy: 'update' }),
    onSuccess: (r) => { setResult(r.data); setStep(3) },
    onError: (e) => toast({ title: 'Import failed', description: e instanceof Error ? e.message : undefined, variant: 'destructive' }),
  })

  const onFile = (f: File | null) => {
    if (!f) return
    void f.text().then((text) => parse.mutate({ csv: text, file_name: f.name }))
  }

  if (!canImport) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 20px' }}>
        <SettingsTabs active="import" />
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <Icon.lock size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>Imports need Manager or above</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
            Bulk writes are restricted (§16) — ask a manager or admin.
          </div>
        </div>
      </div>
    )
  }

  const STEPS = ['1 · Source', '2 · Map', '3 · Dry run', '4 · Results']

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 20px' }}>
      <SettingsTabs active="import" />

      {/* Stepper */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {STEPS.map((label, i) => (
          <div key={label} style={{ flex: 1 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: i <= step ? '#fff' : 'var(--text-faint)', marginBottom: 5 }}>{label}</div>
            <div style={{ height: 3.5, borderRadius: 99, background: i <= step ? 'var(--blue)' : 'var(--surf-2)' }} />
          </div>
        ))}
      </div>

      {step === 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
            {SOURCES.map((src) => (
              <button key={src.id} onClick={() => setPreset(src.id)} style={{
                textAlign: 'left', padding: '14px 14px', borderRadius: 12, cursor: 'pointer',
                background: preset === src.id ? 'rgba(62,123,250,.1)' : 'var(--surf-1)',
                border: `1px solid ${preset === src.id ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`,
              }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: preset === src.id ? '#fff' : 'var(--text-1)' }}>{src.label}</div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 3 }}>{src.sub}</div>
              </button>
            ))}
          </div>
          <div
            className="card"
            onClick={() => fileRef.current?.click()}
            style={{ textAlign: 'center', padding: '34px 24px', cursor: 'pointer', border: '1px dashed var(--bord-2)' }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0] ?? null) }}
          >
            <Icon.upload size={20} style={{ color: 'var(--text-mute)', marginBottom: 10 }} />
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
              {preset === 'linear' ? 'Drop Linear CSV export' : preset === 'jira' ? 'Drop Jira Cloud export (CSV)' : 'Drop your CSV'}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
              {preset === 'jira' ? 'epics→projects · story points→estimate' : preset === 'linear' ? 'teams, states, labels, issues, projects — the switching lever' : 'fields incl. team/state/labels/estimate'}
            </div>
            <div style={{ marginTop: 14 }}>
              <Btn kind="primary" size="sm">{parse.isPending ? 'Reading…' : 'Choose file'}</Btn>
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
          </div>
        </>
      )}

      {step === 1 && parsed && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--bord)' }}>
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{parsed.file_name}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)' }}>· {parsed.rows.toLocaleString()} rows</span>
            <span style={{ flex: 1 }} />
            <Pill tone="blue">{preset === 'linear' ? 'Linear preset' : preset === 'jira' ? 'Jira preset' : 'CSV'}</Pill>
          </div>
          {parsed.headers.map((h) => (
            <div key={h.column} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--bord)' }}>
              <span style={{ width: 180, fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.column}</span>
              <Icon.arrow size={11} style={{ color: 'var(--text-faint)' }} />
              <select
                className="input"
                value={mapping[h.column] ?? 'skip'}
                onChange={(e) => setMapping((m) => ({ ...m, [h.column]: e.target.value }))}
                style={{ height: 30, fontSize: 11.5, fontWeight: 700, width: 170 }}
              >
                {parsed.targets.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {h.samples.filter(Boolean).slice(0, 2).join(' · ')}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>
              external-id dedupe: re-running is idempotent (source + import ref)
            </span>
            <span style={{ flex: 1 }} />
            <Btn kind="primary" size="sm" onClick={() => dryRun.mutate()} disabled={dryRun.isPending}>
              {dryRun.isPending ? 'Running…' : 'Run dry run'}
            </Btn>
          </div>
        </div>
      )}

      {step === 2 && dry && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            {[
              [`${dry.rows_read.toLocaleString()} rows`, 'var(--text-1)'],
              [`${dry.will_create.toLocaleString()} will create`, 'var(--green)'],
              [`${dry.will_update.toLocaleString()} will update`, 'var(--blue)'],
              [`${dry.errors.toLocaleString()} errors`, 'var(--coral)'],
            ].map(([label, color]) => (
              <div key={label as string} className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: color as string }}>{label}</div>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
            {dry.preview.slice(0, 12).map((p) => (
              <div key={p.row} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderBottom: '1px solid var(--bord)' }}>
                <span style={{ width: 44, fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{p.row}</span>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title || '(missing title)'}</span>
                <Pill tone={p.action === 'create' ? 'green' : p.action === 'update' ? 'blue' : 'coral'}>
                  {p.action === 'update' ? 'update — external id' : p.action === 'error' ? (p.reason ?? 'invalid row') : p.action}
                </Pill>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)' }}>nothing is written during a dry run</span>
            <span style={{ flex: 1 }} />
            <Btn kind="primary" icon={<Icon.play size={13} />} onClick={() => run.mutate()} disabled={run.isPending}>
              {run.isPending ? 'Importing…' : `Import ${(dry.will_create + dry.will_update).toLocaleString()} rows`}
            </Btn>
          </div>
        </>
      )}

      {step === 3 && result && (
        <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'rgba(39,210,128,.12)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
            <Icon.check size={20} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Import complete</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 16 }}>
            {result.created.toLocaleString()} created · {result.updated.toLocaleString()} updated · {result.skipped.toLocaleString()} skipped · pm.import.completed published
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {result.errors.length > 0 && (
              <Btn kind="secondary" size="sm" icon={<Icon.download size={12} />} onClick={() => {
                const blob = new Blob([JSON.stringify(result.errors, null, 2)], { type: 'application/json' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = 'import-errors.json'
                a.click()
              }}>Error report</Btn>
            )}
            <Btn kind="primary" size="sm" onClick={() => router.push('/pm/issues')}>View imported issues</Btn>
          </div>
        </div>
      )}
    </div>
  )
}
