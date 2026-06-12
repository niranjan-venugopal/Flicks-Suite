'use client'

import { useEffect, useState } from 'react'
import { InvoBtn, InvoCard, INVO } from '@/components/invoicing/invo'
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
  height: 44,
  background: 'rgba(255,255,255,0.05)',
  border: '1.5px solid rgba(255,255,255,0.10)',
  borderRadius: 10,
  padding: '0 12px',
  fontWeight: 600,
  fontSize: 13,
  color: '#fff',
  outline: 'none',
  letterSpacing: '-0.02em',
}
const LABEL: React.CSSProperties = {
  display: 'block',
  fontWeight: 700,
  fontSize: 12,
  color: 'rgba(255,255,255,0.5)',
  marginBottom: 5,
  letterSpacing: '-0.02em',
}

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
    <InvoCard style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em', color: '#fff' }}>{DOC_LABELS[seq.document_type] ?? seq.document_type}</div>
        <span style={{ padding: '4px 12px', borderRadius: 999, background: 'rgba(62,123,250,0.15)', color: INVO.blue, fontWeight: 700, fontSize: 12 }}>FY {e.fy_label}</span>
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
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>Next number: </span>
          <span style={{ fontFamily: 'var(--mono, monospace)', color: pv.tooLong || pv.badChars ? 'var(--coral, #ff6b6b)' : '#fff' }}>
            {pv.sample}
          </span>
          {pv.tooLong && <span style={{ color: '#F8786B', marginLeft: 8 }}>· over 16 chars</span>}
          {pv.badChars && <span style={{ color: '#F8786B', marginLeft: 8 }}>· invalid characters</span>}
        </div>
        <InvoBtn kind="primary" height={40} onClick={onSave} disabled={upsert.isPending}>
          {upsert.isPending ? 'Saving…' : 'Save'}
        </InvoBtn>
      </div>
    </InvoCard>
  )
}

export function NumberingTab() {
  const { data, isLoading, isError } = useSequences()
  if (isLoading) return <div style={{ color: 'rgba(255,255,255,0.5)' }}>Loading sequences…</div>
  if (isError) return <div style={{ color: '#F8786B' }}>Couldn’t load sequences. Check you’re signed in.</div>
  return (
    <div>
      {(data?.data ?? []).map((seq) => (
        <SequenceCard key={seq.document_type} seq={seq} />
      ))}
    </div>
  )
}
