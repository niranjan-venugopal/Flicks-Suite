'use client'

import { useEffect, useState } from 'react'
import { Btn, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useSequences,
  useUpsertSequence,
  type Sequence,
  type SequenceInput,
} from '@/lib/api/queries/use-invoicing'

const DOC_LABELS: Record<string, string> = {
  INVOICE: 'Invoice',
  QUOTE: 'Quote',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
}
const FY_FORMATS = ['26-27', '2026-27', '2026-2027', '2026']
const FIELD: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 13,
}
const LABEL: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }

function localPreview(s: Editable, fyLabel: string): { sample: string; tooLong: boolean; badChars: boolean } {
  const padded = String(s.starting_number || 1).padStart(s.zero_padding ?? 0, '0')
  const sample = [s.prefix, fyLabel, padded].filter((p) => p !== '').join(s.separator)
  return { sample, tooLong: sample.length > 16, badChars: !/^[A-Za-z0-9/-]+$/.test(sample) }
}

interface Editable {
  document_type: string
  prefix: string
  separator: string
  fy_format: string
  zero_padding: number
  starting_number: number
  fy_label: string
}

function SequenceCard({ seq }: { seq: Sequence }) {
  const { toast } = useToast()
  const upsert = useUpsertSequence()
  const [e, setE] = useState<Editable>({
    document_type: seq.document_type,
    prefix: seq.prefix,
    separator: seq.separator,
    fy_format: seq.fy_format,
    zero_padding: seq.zero_padding,
    starting_number: seq.starting_number,
    fy_label: seq.fy_label,
  })
  useEffect(() => {
    setE({
      document_type: seq.document_type,
      prefix: seq.prefix,
      separator: seq.separator,
      fy_format: seq.fy_format,
      zero_padding: seq.zero_padding,
      starting_number: seq.starting_number,
      fy_label: seq.fy_label,
    })
  }, [seq])

  const pv = localPreview(e, e.fy_label)

  const onSave = async () => {
    if (pv.tooLong || pv.badChars) {
      toast({ title: 'Fix the number format first', variant: 'destructive' })
      return
    }
    const payload: SequenceInput = {
      document_type: e.document_type,
      prefix: e.prefix,
      separator: e.separator,
      fy_format: e.fy_format,
      zero_padding: e.zero_padding,
      starting_number: e.starting_number,
    }
    try {
      const res = await upsert.mutateAsync(payload)
      toast({
        title: 'Numbering saved',
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

  return (
    <div className="glass" style={{ borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>{DOC_LABELS[seq.document_type] ?? seq.document_type}</div>
        <Pill tone="blue">FY {e.fy_label}</Pill>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <div>
          <label style={LABEL}>Prefix</label>
          <input style={FIELD} value={e.prefix} onChange={(ev) => setE({ ...e, prefix: ev.target.value })} />
        </div>
        <div>
          <label style={LABEL}>Separator</label>
          <input style={FIELD} value={e.separator} onChange={(ev) => setE({ ...e, separator: ev.target.value })} />
        </div>
        <div>
          <label style={LABEL}>FY format</label>
          <select style={FIELD} value={e.fy_format} onChange={(ev) => setE({ ...e, fy_format: ev.target.value })}>
            {FY_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={LABEL}>Zero padding</label>
          <input
            style={FIELD}
            type="number"
            min={0}
            max={10}
            value={e.zero_padding}
            onChange={(ev) => setE({ ...e, zero_padding: Number(ev.target.value) })}
          />
        </div>
        <div>
          <label style={LABEL}>Start #</label>
          <input
            style={FIELD}
            type="number"
            min={1}
            value={e.starting_number}
            onChange={(ev) => setE({ ...e, starting_number: Number(ev.target.value) })}
          />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--muted)' }}>Next number: </span>
          <span style={{ fontFamily: 'var(--mono, monospace)', color: pv.tooLong || pv.badChars ? 'var(--coral, #ff6b6b)' : 'var(--text)' }}>
            {pv.sample}
          </span>
          {pv.tooLong && <span style={{ color: 'var(--coral, #ff6b6b)', marginLeft: 8 }}>· over 16 chars</span>}
          {pv.badChars && <span style={{ color: 'var(--coral, #ff6b6b)', marginLeft: 8 }}>· invalid characters</span>}
        </div>
        <Btn kind="primary" size="sm" onClick={onSave} disabled={upsert.isPending}>
          {upsert.isPending ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </div>
  )
}

export function NumberingTab() {
  const { data, isLoading, isError } = useSequences()
  if (isLoading) return <div style={{ color: 'var(--muted)' }}>Loading sequences…</div>
  if (isError) return <div style={{ color: 'var(--coral, #ff6b6b)' }}>Couldn’t load sequences. Check you’re signed in.</div>
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
        Numbers reset automatically at the start of each financial year. Numbers must be ≤16 characters and use only
        letters, digits, “-” and “/”. Changing numbering mid-year can affect GST compliance.
      </p>
      {(data?.data ?? []).map((seq) => (
        <SequenceCard key={seq.document_type} seq={seq} />
      ))}
    </div>
  )
}
