'use client'

import { Suspense, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useImportParse,
  useImportDryRun,
  useImportRun,
  useImportBatches,
  useImportUndo,
  downloadImportTemplate,
  type ImportParseResult,
  type ImportDryRun,
  type ImportBatch,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C14 — Import wizard: upload → map columns → dedupe
// strategy → dry run → results (+ 24h undo). One object
// type per run; beta cap 10,000 rows.
// ─────────────────────────────────────────────────────────

const STEPS = ['Upload', 'Map columns', 'Dedupe', 'Dry run', 'Results']
const OBJECTS: Array<['people' | 'companies' | 'leads', string]> = [['people', 'Contacts'], ['companies', 'Companies'], ['leads', 'Leads']]

export default function ImportPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <ImportWizard />
    </Suspense>
  )
}

function ImportWizard() {
  const { toast } = useToast()
  const parse = useImportParse()
  const dryRun = useImportDryRun()
  const run = useImportRun()
  const fileRef = useRef<HTMLInputElement>(null)
  // Entity pages deep-link here (round B): /crm/import?object=leads
  const params = useSearchParams()
  const initialObject = params.get('object')

  const [step, setStep] = useState(1)
  const [object, setObject] = useState<'people' | 'companies' | 'leads'>(
    initialObject === 'leads' || initialObject === 'companies' || initialObject === 'people'
      ? initialObject
      : 'people',
  )
  const [dragOver, setDragOver] = useState(false)
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ImportParseResult | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [strategy, setStrategy] = useState<'skip' | 'update' | 'create'>('update')
  const [plan, setPlan] = useState<ImportDryRun | null>(null)
  const [result, setResult] = useState<ImportBatch | null>(null)

  const onFile = async (f: File) => {
    const text = await f.text()
    try {
      const res = await parse.mutateAsync({ object, csv: text, file_name: f.name })
      setCsv(text)
      setFileName(f.name)
      setParsed(res.data)
      setMapping(Object.fromEntries(res.data.headers.filter((h) => h.suggested).map((h) => [h.column, h.suggested!])))
      setStep(2)
    } catch (err) {
      toast({ title: 'Could not read the file', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const doDryRun = async () => {
    try {
      const res = await dryRun.mutateAsync({ object, csv, mapping, strategy, file_name: fileName })
      setPlan(res.data)
      setStep(4)
    } catch (err) {
      toast({ title: 'Dry run failed', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const doRun = async () => {
    try {
      const res = await run.mutateAsync({ object, csv, mapping, strategy, file_name: fileName })
      setResult(res.data)
      setStep(5)
    } catch (err) {
      toast({ title: 'Import failed', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 860, margin: '0 auto' }}>
      <SectionHead title="Import" sub="CSV in, records out — dry runs are free, real runs are undoable for 24h." />

      <div style={{ display: 'flex', gap: 6, marginBottom: 22 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ height: 4, borderRadius: 99, width: '100%', background: i + 1 <= step ? 'var(--blue)' : 'var(--surf-2)' }} />
            <span style={{ fontSize: 10.5, fontWeight: 800, color: i + 1 === step ? '#fff' : 'var(--text-faint)', letterSpacing: '.03em' }}>{i + 1} · {s}</span>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div
          className="card"
          // "Drop your CSV" finally accepts a drop (round B) — the copy had
          // promised it since C14 with no handler behind it.
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void onFile(f)
          }}
          style={{
            textAlign: 'center', padding: '44px 24px',
            border: dragOver ? '1px dashed rgba(62,123,250,.6)' : undefined,
            background: dragOver ? 'rgba(62,123,250,.05)' : undefined,
          }}
        >
          <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', color: 'var(--text-mute)' }}>
            <Icon.upload size={24} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Drop your CSV</div>
          <div className="t-mute" style={{ fontSize: 12, marginBottom: 16 }}>Up to 10,000 rows per file · header row required · exports from Zoho or HubSpot map automatically</div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 16 }}>
            {OBJECTS.map(([k, l]) => (
              <button key={k} onClick={() => setObject(k)} style={{ padding: '7px 14px', borderRadius: 8, cursor: 'pointer', background: object === k ? 'rgba(62,123,250,.14)' : 'var(--surf-1)', border: `1px solid ${object === k ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`, color: object === k ? 'var(--blue)' : 'var(--text-2)', fontSize: 12, fontWeight: 800 }}>{l}</button>
            ))}
          </div>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f) }} />
          <Btn kind="primary" icon={<Icon.upload size={14} />} disabled={parse.isPending} onClick={() => fileRef.current?.click()}>
            {parse.isPending ? 'Reading…' : 'Choose file'}
          </Btn>
          <div style={{ marginTop: 14 }}>
            <button
              onClick={() => void downloadImportTemplate(object)}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}
            >
              Download the {OBJECTS.find(([k]) => k === object)?.[1].toLowerCase()} template
            </button>
          </div>
          <PastFallback onCsv={(text) => void onFile(new File([text], 'pasted.csv'))} />
        </div>
      )}

      {step === 2 && parsed && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div className="t-h3" style={{ flex: 1 }}>{fileName || 'file.csv'} · {parsed.rows.toLocaleString()} rows</div>
            <Pill tone="blue">{OBJECTS.find(([k]) => k === object)?.[1]}</Pill>
          </div>
          <table className="tbl">
            <thead><tr><th>CSV column</th><th></th><th>Maps to</th><th>Sample</th></tr></thead>
            <tbody>
              {parsed.headers.map((h) => (
                <tr key={h.column}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{h.column}</td>
                  <td><Icon.arrow size={13} style={{ color: 'var(--text-faint)' }} /></td>
                  <td>
                    <select className="input" style={{ height: 32, fontSize: 11.5, width: 200 }} value={mapping[h.column] ?? ''}
                      onChange={(e) => setMapping((m) => ({ ...m, [h.column]: e.target.value }))}>
                      <option value="">Skip column</option>
                      {parsed.targets.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="t-mute" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.samples.filter(Boolean)[0] ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
            <Btn kind="ghost" size="sm" onClick={() => setStep(1)}>Back</Btn>
            <Btn kind="primary" size="sm" disabled={!Object.values(mapping).some(Boolean)} onClick={() => setStep(3)}>Continue</Btn>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
          <div className="t-h3" style={{ marginBottom: 12 }}>When a match already exists…</div>
          {([['skip', 'Skip the row', 'safest — nothing is overwritten'], ['update', 'Update existing', 'fills blanks + overwrites mapped fields'], ['create', 'Create anyway', 'allowed — flagged later by the dedupe finder']] as const).map(([k, l, s]) => (
            <button key={k} onClick={() => setStrategy(k)} style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 13px', borderRadius: 10, marginBottom: 8, background: strategy === k ? 'rgba(62,123,250,.08)' : 'var(--surf-1)', border: `1px solid ${strategy === k ? 'rgba(62,123,250,.4)' : 'var(--bord)'}`, cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ width: 15, height: 15, borderRadius: '50%', flexShrink: 0, marginTop: 1, border: `4.5px solid ${strategy === k ? 'var(--blue)' : 'var(--bord-2)'}` }} />
              <div><div style={{ fontSize: 12.5, fontWeight: 800, color: '#fff' }}>{l}</div><div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{s}</div></div>
            </button>
          ))}
          <div className="t-caption" style={{ marginBottom: 14 }}>Match on: person email · company domain/name · lead email. Duplicate rows inside the file are skipped.</div>
          <Btn kind="primary" size="sm" style={{ width: '100%', justifyContent: 'center' }} disabled={dryRun.isPending} onClick={() => void doDryRun()}>
            {dryRun.isPending ? 'Planning…' : 'Run dry run'}
          </Btn>
        </div>
      )}

      {step === 4 && plan && (
        <div className="card">
          <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            {([[plan.rows_read, 'rows read', ''], [plan.will_create, 'will create', 'green'], [plan.will_update, 'will update', 'blue'], [plan.will_skip, 'will skip', 'yellow'], [plan.errors, 'errors', 'coral']] as const).map(([n, l, c]) => (
              <div key={l} style={{ flex: 1, minWidth: 110, padding: '12px 14px', borderRadius: 11, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}>
                <div className="t-num" style={{ fontSize: 19, fontWeight: 800, color: c ? `var(--${c})` : '#fff' }}>{n.toLocaleString()}</div>
                <div className="t-caption">{l}</div>
              </div>
            ))}
          </div>
          <div className="t-caption" style={{ marginBottom: 8 }}>First 50 rows — errors inline</div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Row</th><th>Values</th><th>Status</th></tr></thead>
              <tbody>
                {plan.preview.map((r) => (
                  <tr key={r.row}>
                    <td className="t-num">{r.row}</td>
                    <td style={{ fontSize: 11.5, fontWeight: 700, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {Object.values(r.values).filter(Boolean).join(' · ')}
                    </td>
                    <td>
                      <Pill tone={r.action === 'create' ? 'green' : r.action === 'update' ? 'blue' : r.action === 'skip' ? 'yellow' : 'coral'}>
                        {r.action}{r.reason ? ` — ${r.reason}` : ''}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <span className="t-caption">Nothing is written during a dry run</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="ghost" size="sm" onClick={() => setStep(3)}>Back</Btn>
              <Btn kind="primary" size="sm" icon={<Icon.play size={12} />} disabled={run.isPending || plan.will_create + plan.will_update === 0} onClick={() => void doRun()}>
                {run.isPending ? 'Importing…' : `Import ${(plan.will_create + plan.will_update).toLocaleString()} rows`}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {step === 5 && result && (
        <div className="card" style={{ padding: '36px 24px' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(39,210,128,.14)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <Icon.check size={24} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Import complete</div>
            <div className="t-mute" style={{ fontSize: 12, marginBottom: 16 }}>
              {result.rows_created.toLocaleString()} created · {result.rows_updated.toLocaleString()} updated · {result.rows_skipped.toLocaleString()} skipped
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <Btn kind="secondary" size="sm" onClick={() => { setStep(1); setResult(null); setPlan(null); setParsed(null); setCsv('') }}>Import another file</Btn>
              <Btn kind="primary" size="sm" onClick={() => { window.location.href = object === 'leads' ? '/crm/leads' : object === 'companies' ? '/crm/companies' : '/crm/contacts' }}>
                View imported records
              </Btn>
            </div>
          </div>
          {/* Round B: the per-row errors were stored since C14 and never
              shown — the founder's users just saw a smaller count. */}
          {(result.errors?.length ?? 0) > 0 && (
            <div style={{ marginTop: 22, textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--coral)' }}>
                  {result.errors!.length} row{result.errors!.length === 1 ? '' : 's'} failed
                </span>
                <span style={{ flex: 1 }} />
                <Btn
                  kind="ghost"
                  size="sm"
                  icon={<Icon.download size={12} />}
                  onClick={() => {
                    const csvOut = ['row,error', ...result.errors!.map((e) => `${e.row},"${e.error.replace(/"/g, '""')}"`)].join('\r\n')
                    const blob = new Blob([csvOut], { type: 'text/csv;charset=utf-8' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${(fileName || 'import').replace(/\.csv$/i, '')}-errors.csv`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  Error report
                </Btn>
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th style={{ width: 70 }}>Row</th><th>Problem</th></tr></thead>
                  <tbody>
                    {result.errors!.slice(0, 50).map((e) => (
                      <tr key={e.row}>
                        <td className="t-num">{e.row}</td>
                        <td style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <RecentImports />
    </div>
  )
}

function PastFallback({ onCsv }: { onCsv: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  return (
    <div style={{ marginTop: 16 }}>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', color: 'var(--text-mute)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>
          …or paste CSV text
        </button>
      ) : (
        <div style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left' }}>
          <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={'name,email\nAsha Rao,asha@example.com'}
            style={{ width: '100%', height: 110, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11.5, resize: 'vertical' }} />
          <Btn kind="secondary" size="sm" style={{ marginTop: 8 }} disabled={!text.trim()} onClick={() => onCsv(text)}>Use pasted text</Btn>
        </div>
      )}
    </div>
  )
}

function RecentImports() {
  const { data } = useImportBatches()
  const undo = useImportUndo()
  const { toast } = useToast()
  const rows = data?.data ?? []
  if (rows.length === 0) return null
  const undoable = (b: ImportBatch) => b.status === 'done' && Date.now() - new Date(b.created_at).getTime() < 24 * 3600_000
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 18 }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bord)' }}><div className="t-h3" style={{ fontSize: 13 }}>Recent imports</div></div>
      {rows.map((b, i) => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800 }}>{b.file_name ?? 'import.csv'} <span style={{ color: 'var(--text-mute)', fontWeight: 600 }}>· {b.object_type}</span></div>
            <div className="t-mute" style={{ fontSize: 10.5 }}>{new Date(b.created_at).toLocaleString()} · {b.rows_created} created · {b.rows_updated} updated · {b.rows_skipped} skipped</div>
          </div>
          {b.status === 'undone'
            ? <Pill tone="yellow">undone</Pill>
            : undoable(b)
              ? <Btn kind="ghost" size="sm" icon={<Icon.refresh size={12} />} disabled={undo.isPending}
                  onClick={() => undo.mutate(b.id, { onSuccess: () => toast({ title: 'Import undone', description: 'Everything the batch created was retracted.' }) })}>
                  Undo
                </Btn>
              : <span className="t-caption">undo window passed</span>}
        </div>
      ))}
    </div>
  )
}
