'use client'

import { useEffect, useMemo, useState } from 'react'
import { Btn, Icon, Pill, Toggle } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useSequences,
  useUpsertSequence,
  type Sequence,
} from '@/lib/api/queries/use-invoicing'

/**
 * Numbering tab — exact port of the v3 prototype's NumberingTab
 * (screens-settings.jsx): left rail of sequence cards, editor card, live
 * preview with GST Rule 46(b) validation pills, April-1 auto-reset row, and
 * the mid-FY-change warning. Wired to the real sequences API.
 */

interface Editable {
  document_type: string
  label: string
  prefix: string
  separator: string
  fy_format: string
  zero_padding: number
  starting_number: number
  fy_label: string
  current_number: number
}

const DOC_LABELS: Record<string, string> = {
  INVOICE: 'Invoices',
  QUOTE: 'Quotes',
  CREDIT_NOTE: 'Credit notes',
  DEBIT_NOTE: 'Debit notes',
}

const buildNumber = (s: Editable) =>
  [s.prefix, s.fy_label, String(Math.max(s.current_number + 1, s.starting_number)).padStart(s.zero_padding, '0')]
    .filter(Boolean)
    .join(s.separator)

function validateNumber(str: string): string[] {
  const issues: string[] = []
  if (str.length > 16) issues.push(`Too long (${str.length}/16 chars)`)
  if (!/^[A-Za-z0-9/-]+$/.test(str)) issues.push('Only A–Z, 0–9, “-” and “/” allowed')
  return issues
}

const toEditable = (q: Sequence): Editable => ({
  document_type: q.document_type,
  label: DOC_LABELS[q.document_type] ?? q.document_type,
  prefix: q.prefix,
  separator: q.separator,
  fy_format: q.fy_format,
  zero_padding: q.zero_padding,
  starting_number: q.starting_number,
  fy_label: q.fy_label,
  current_number: q.current_number,
})

export function NumberingTab() {
  const { toast } = useToast()
  const { data, isLoading, isError } = useSequences()
  const upsert = useUpsertSequence()

  const [seqs, setSeqs] = useState<Editable[]>([])
  const [sel, setSel] = useState(0)
  const [reset, setReset] = useState(true)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (data?.data && !touched) setSeqs(data.data.map(toEditable))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const s = seqs[sel]
  const preview = useMemo(() => (s ? buildNumber(s) : ''), [s])
  const issues = useMemo(() => (s ? validateNumber(preview) : []), [preview, s])

  const upd = (k: keyof Editable, v: string | number) => {
    setTouched(true)
    setSeqs((arr) =>
      arr.map((x, i) =>
        i === sel
          ? { ...x, [k]: k === 'zero_padding' || k === 'starting_number' ? Number(v) || 0 : v }
          : x,
      ),
    )
  }

  const onSave = async () => {
    if (!s || issues.length) return
    try {
      const res = await upsert.mutateAsync({
        document_type: s.document_type,
        prefix: s.prefix,
        separator: s.separator,
        fy_format: s.fy_format,
        zero_padding: s.zero_padding,
        starting_number: s.starting_number,
      })
      setTouched(false)
      toast({
        title: `Numbering saved — next: ${res.sample ?? preview}`,
        description: res.warning,
        variant: res.warning ? 'destructive' : undefined,
      })
    } catch (err) {
      toast({
        title: 'Could not save numbering',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const onReset = () => {
    if (data?.data) setSeqs(data.data.map(toEditable))
    setTouched(false)
  }

  if (isLoading) return <div className="t-mute">Loading sequences…</div>
  if (isError || !s)
    return <div style={{ color: 'var(--coral)' }} className="text-sm font-semibold">Couldn’t load sequences. Check you’re signed in.</div>

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20 }}>
      {/* sequence picker rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {seqs.map((q, i) => (
          <button
            key={q.document_type}
            onClick={() => setSel(i)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '12px 14px',
              borderRadius: 10,
              textAlign: 'left',
              cursor: 'pointer',
              background: sel === i ? 'var(--surf-2)' : 'var(--surf-1)',
              border: `1px solid ${sel === i ? 'var(--bord-2)' : 'var(--bord)'}`,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 800, color: sel === i ? '#fff' : 'var(--text-2)' }}>{q.label}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>
              {buildNumber(q)}
            </div>
          </button>
        ))}
      </div>

      {/* editor */}
      <div>
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <div className="label">Prefix</div>
              <input className="input" value={s.prefix} onChange={(e) => upd('prefix', e.target.value.toUpperCase())} />
            </div>
            <div>
              <div className="label">Separator</div>
              <select className="input" value={s.separator} onChange={(e) => upd('separator', e.target.value)}>
                <option value="/">/</option>
                <option value="-">-</option>
              </select>
            </div>
            <div>
              <div className="label">FY token</div>
              <select className="input" value={s.fy_format} onChange={(e) => upd('fy_format', e.target.value)}>
                <option value="26-27">26-27</option>
                <option value="2026-27">2026-27</option>
                <option value="2026-2027">2026-2027</option>
                <option value="2026">2026</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <div className="label">Pad width</div>
              <input
                className="input t-num"
                type="number"
                min={1}
                max={8}
                value={s.zero_padding}
                onChange={(e) => upd('zero_padding', e.target.value)}
              />
            </div>
            <div>
              <div className="label">Starting number</div>
              <input
                className="input t-num"
                type="number"
                min={0}
                value={s.starting_number}
                onChange={(e) => upd('starting_number', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* live preview */}
        <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 18 }}>
          <div>
            <div className="t-caption" style={{ marginBottom: 6 }}>Next number</div>
            <div
              style={{
                fontSize: 26,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                fontFamily: 'var(--font-mono)',
                color: issues.length ? 'var(--coral)' : '#fff',
              }}
            >
              {preview}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {issues.length === 0 ? (
            <Pill tone="green" icon={<Icon.check size={12} />}>GST Rule 46(b) valid</Pill>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
              {issues.map((iss, i) => (
                <Pill key={i} tone="coral" icon={<Icon.warn size={12} />}>{iss}</Pill>
              ))}
            </div>
          )}
        </div>

        {/* April 1 reset */}
        <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Auto-reset on April 1</div>
            <div className="t-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
              On the FY boundary the sequence restarts at {String(s.starting_number).padStart(s.zero_padding, '0')} with
              the new FY token (e.g. {s.prefix}{s.separator}25-26{s.separator}0142 → {s.prefix}{s.separator}26-27{s.separator}{String(s.starting_number).padStart(s.zero_padding, '0')}).
            </div>
          </div>
          <Toggle on={reset} onChange={setReset} />
        </div>

        {/* mid-FY warning */}
        {touched && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 10,
              background: 'rgba(254,216,0,.1)',
              border: '1px solid rgba(254,216,0,.3)',
            }}
          >
            <span style={{ color: 'var(--yellow)', flexShrink: 0 }}>
              <Icon.warn size={16} />
            </span>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', lineHeight: 1.5 }}>
              Changing prefix or starting number mid-FY can break GST compliance (consecutive numbering). Consult your CA.{' '}
              <span style={{ color: 'var(--text-mute)' }}>
                Gap detection is active — a resequence affordance appears to Owner/Admin if a gap is found.
              </span>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn kind="ghost" onClick={onReset}>Reset</Btn>
          <Btn
            kind="primary"
            icon={<Icon.check size={15} />}
            onClick={onSave}
            disabled={issues.length > 0 || upsert.isPending}
          >
            {upsert.isPending ? 'Saving…' : 'Save numbering'}
          </Btn>
        </div>
      </div>
    </div>
  )
}
