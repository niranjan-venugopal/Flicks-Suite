'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Icon, Pill } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  useSequences,
  useUpsertSequence,
  usePreviewNumber,
  sequenceSeriesMode,
  SEQUENCE_FY_FORMATS,
  SEQUENCE_SEPARATORS,
  type Sequence,
  type SequenceInput,
  type SeriesMode,
} from '@/lib/api/queries/use-invoicing'

/**
 * Numbering tab — port of the v3 prototype's NumberingTab (screens-settings.jsx):
 * left rail of sequence cards, series-mode cards, editor card, live preview
 * with GST Rule 46(b) validation pills and the issued-numbers warning. Wired
 * to the real sequences API.
 *
 * Round P R2 (contracts K2–K4): a document type runs either a financial-year
 * series (PREFIX{sep}FY{sep}NNNN, restarts every FY) or a continuous series
 * (PREFIX{sep?}NNNNN, never resets — separator '' allowed, no FY token). The
 * client-side preview mirrors the API's formatter exactly:
 *   [prefix, (fy token in FY mode), padded].filter(non-empty).join(separator)
 * where the FY token is re-rendered under the *selected* format (the loaded
 * row's label was rendered under the stored one). An API build that predates
 * R2 omits series_mode → treated as 'fiscal_year'.
 *
 * The API only reports the continuous ('ALL') counter while a document type is
 * already in continuous mode. Selecting "Continuous series" on a
 * financial-year row therefore asks POST /preview (series_mode 'continuous')
 * for that counter once, so the preview and the "resumes at N" note show the
 * number the series will really issue — until it answers the preview is
 * labelled as unconfirmed rather than asserting the starting number.
 */

interface Editable {
  document_type: string
  label: string
  prefix: string
  separator: string
  fy_format: string
  zero_padding: number
  starting_number: number
  /** The FY token as the API rendered it under the *stored* fy_format. */
  fy_label: string
  /** Start year parsed from fy_label; null when the label is not one of the four formats. */
  fy_start_year: number | null
  /** Counter of the current financial-year row. */
  current_number: number
  series_mode: SeriesMode
  /**
   * Counter of the continuous row. null = not known: the API omits it while
   * the row is in financial-year mode (and an older API never sends it); the
   * tab resolves it through POST /preview when continuous mode is selected.
   */
  continuous_current_number: number | null
  /** true when the API row carried series_mode, i.e. the API accepts the field. */
  api_has_series_mode: boolean
}

const DOC_LABELS: Record<string, string> = {
  INVOICE: 'Invoices',
  QUOTE: 'Quotes',
  CREDIT_NOTE: 'Credit notes',
  DEBIT_NOTE: 'Debit notes',
}

const MODES: { value: SeriesMode; title: string; desc: string; example: string }[] = [
  {
    value: 'fiscal_year',
    title: 'Financial-year series',
    desc: 'Restarts every financial year (April 1) with the FY token in the number.',
    example: 'INV/26-27/0001',
  },
  {
    value: 'continuous',
    title: 'Continuous series',
    desc: 'One running counter that never resets — no FY token, separator optional.',
    example: 'LB2400001',
  },
]

/** GST Rule 46(b): ≤ 16 characters, alphanumerics plus "-" and "/". */
const MAX_NUMBER_LENGTH = 16
const NUMBER_CHARSET = /^[A-Za-z0-9/-]+$/
/** How far ahead the horizon warning looks (contract K2). */
const HORIZON: Record<SeriesMode, number> = { fiscal_year: 9_999, continuous: 99_999 }

type FormatParts = Pick<
  Editable,
  'prefix' | 'separator' | 'fy_label' | 'fy_format' | 'fy_start_year' | 'zero_padding' | 'series_mode'
>

/** Mirrors the API's formatFyLabel (numbering.util.ts) for the four FY token formats. */
function formatFyLabel(fyFormat: string, startYear: number, endYear: number): string {
  const s2 = String(startYear).slice(2)
  const e2 = String(endYear).slice(2)
  switch (fyFormat) {
    case '2026-2027':
      return `${startYear}-${endYear}`
    case '2026-27':
      return `${startYear}-${e2}`
    case '2026':
      return `${startYear}`
    case '26-27':
    default:
      return `${s2}-${e2}`
  }
}

/**
 * The FY's start year read back from a label the API rendered in any of the
 * four formats ('26-27', '2026-27', '2026-2027', '2026'); null for anything
 * else. A two-digit year belongs to the current century.
 */
function parseFyStartYear(label: string): number | null {
  const m = /^(\d{4}|\d{2})(?:-(?:\d{4}|\d{2}))?$/.exec(label.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[1].length === 4 ? n : Math.floor(new Date().getFullYear() / 100) * 100 + n
}

/** The FY token under the *selected* format (the API recomputes it from fy_format on save). */
const fyLabelFor = (s: FormatParts) =>
  s.fy_start_year == null ? s.fy_label : formatFyLabel(s.fy_format, s.fy_start_year, s.fy_start_year + 1)

/** Mirrors the API's formatter (contract K3). */
const formatNumber = (s: FormatParts, n: number) =>
  [s.prefix, s.series_mode === 'fiscal_year' ? fyLabelFor(s) : '', String(n).padStart(s.zero_padding, '0')]
    .filter(Boolean)
    .join(s.separator)

/** The counter the selected mode runs on (an unknown continuous counter reads as 0 until resolved). */
const activeCounter = (s: Editable) =>
  s.series_mode === 'continuous' ? (s.continuous_current_number ?? 0) : s.current_number

const nextNumber = (s: Editable) => Math.max(activeCounter(s) + 1, s.starting_number)

const buildNumber = (s: Editable) => formatNumber(s, nextNumber(s))

/**
 * Numbers issued on the counter a loaded row is running on — the API's
 * `issuedBefore` (the ALL row while continuous, else this FY's row). This is
 * the counter a series change disturbs, whichever mode the user picks next.
 */
const issuedOnLoaded = (q: Sequence) =>
  sequenceSeriesMode(q) === 'continuous' ? (q.continuous_current_number ?? 0) : q.current_number

/** Blocking issues: the formatted number and the numeric bounds the API enforces. */
function validateConfig(s: Editable, preview: string): string[] {
  const issues: string[] = []
  if (preview.length > MAX_NUMBER_LENGTH) issues.push(`Too long (${preview.length}/${MAX_NUMBER_LENGTH} chars)`)
  if (!NUMBER_CHARSET.test(preview)) issues.push('Only A–Z, 0–9, “-” and “/” allowed')
  if (!Number.isInteger(s.zero_padding) || s.zero_padding < 1 || s.zero_padding > 8) issues.push('Pad width must be 1–8')
  if (!Number.isInteger(s.starting_number) || s.starting_number < 1) issues.push('Starting number must be at least 1')
  return issues
}

/**
 * Non-blocking: the series will outgrow 16 characters inside the horizon —
 * the next 99,999 numbers (continuous) / 9,999 (FY) counting from the next
 * number, the same window the API's validateNumberFormat probes. The length
 * only grows when the number gains a digit beyond the pad width, so name the
 * first number that no longer fits.
 */
function horizonWarning(s: Editable): string | undefined {
  if (!Number.isInteger(s.starting_number) || s.starting_number < 1) return undefined
  const last = nextNumber(s) + HORIZON[s.series_mode] - 1
  if (formatNumber(s, last).length <= MAX_NUMBER_LENGTH) return undefined
  const fixed = formatNumber(s, 1).length - Math.max(s.zero_padding, 1) // everything but the digits
  const digitsAllowed = MAX_NUMBER_LENGTH - fixed
  const lastFitting = 10 ** Math.max(digitsAllowed, 0) - 1
  return `Numbers above ${lastFitting.toLocaleString('en-IN')} will exceed ${MAX_NUMBER_LENGTH} chars — shorten the prefix or pad`
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
  fy_start_year: parseFyStartYear(q.fy_label),
  current_number: q.current_number,
  series_mode: sequenceSeriesMode(q),
  continuous_current_number: q.continuous_current_number ?? null,
  api_has_series_mode: q.series_mode !== undefined,
})

export function NumberingTab() {
  const { toast } = useToast()
  const { data, isLoading, isError } = useSequences()
  const upsert = useUpsertSequence()
  const previewNumber = usePreviewNumber()

  const [seqs, setSeqs] = useState<Editable[]>([])
  const [sel, setSel] = useState(0)
  const [touched, setTouched] = useState(false)
  // Document types whose continuous counter has been asked for since the last
  // load — one probe per type, retried only after a failure.
  const probedRef = useRef(new Set<string>())

  useEffect(() => {
    if (data?.data && !touched) {
      setSeqs(data.data.map(toEditable))
      probedRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const s = seqs[sel]
  const loaded = data?.data?.find((q) => q.document_type === s?.document_type)
  const preview = useMemo(() => (s ? buildNumber(s) : ''), [s])
  const issues = useMemo(() => (s ? validateConfig(s, preview) : []), [preview, s])
  const warning = useMemo(() => (s && issues.length === 0 ? horizonWarning(s) : undefined), [s, issues])
  const isContinuous = s?.series_mode === 'continuous'
  // Continuous selected on a row the API reported in FY mode: the ALL counter
  // is still being fetched (or the fetch failed), so the preview is provisional.
  const continuousUnknown = !!s && isContinuous && s.continuous_current_number === null
  // Numbers already issued on the counter the chosen mode runs on (where the
  // series would resume) — and on the counter the loaded row was running on
  // (what a change disturbs; mirrors the API's `issuedBefore`).
  const issued = s ? activeCounter(s) : 0
  const issuedBefore = loaded ? issuedOnLoaded(loaded) : 0
  const modeChanged = !!s && !!loaded && sequenceSeriesMode(loaded) !== s.series_mode
  // "Resumes at N, not at your starting number" is only true when the target
  // counter is already past that starting number (the API's own gate).
  const resumesPastStart = !!s && modeChanged && !continuousUnknown && issued >= s.starting_number

  // Resolve the continuous counter the list omits in FY mode: POST /preview
  // honours series_mode and, asked for the barest continuous number (no
  // prefix, no separator, pad 1), answers exactly String(counter + 1) by the
  // K3 formatter — so the preview and the resume note use the real counter.
  const docType = s?.document_type
  useEffect(() => {
    if (!docType || !continuousUnknown || probedRef.current.has(docType)) return
    probedRef.current.add(docType)
    previewNumber
      .mutateAsync({
        document_type: docType,
        series_mode: 'continuous',
        prefix: '',
        separator: '',
        zero_padding: 1,
        starting_number: 1,
      })
      .then((res) => {
        const next = Number(res.data.next_number_preview)
        if (!Number.isInteger(next) || next < 1) throw new Error('unexpected preview')
        setSeqs((arr) =>
          arr.map((x) =>
            x.document_type === docType && x.continuous_current_number === null
              ? { ...x, continuous_current_number: next - 1 }
              : x,
          ),
        )
      })
      .catch(() => {
        // Older API or transient failure: stay "unknown" and allow a retry
        // the next time continuous mode is selected for this type.
        probedRef.current.delete(docType)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docType, continuousUnknown])

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
    const input: SequenceInput = {
      document_type: s.document_type,
      prefix: s.prefix,
      separator: s.separator,
      fy_format: s.fy_format,
      zero_padding: s.zero_padding,
      starting_number: s.starting_number,
      // The API rejects unknown fields, so an older build only sees
      // series_mode when it already reported one — or when the user asks for
      // continuous, which that build cannot honour and must refuse.
      ...(s.api_has_series_mode || s.series_mode === 'continuous' ? { series_mode: s.series_mode } : {}),
    }
    try {
      const res = await upsert.mutateAsync(input)
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
    probedRef.current.clear()
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
            <div style={{ fontSize: 12.5, fontWeight: 800, color: sel === i ? 'var(--text)' : 'var(--text-2)' }}>{q.label}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>
              {buildNumber(q)}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)' }}>
              {q.series_mode === 'continuous' ? 'Continuous' : 'Financial year'}
            </div>
          </button>
        ))}
      </div>

      {/* editor */}
      <div>
        {/* series mode */}
        <div
          role="radiogroup"
          aria-label="Numbering series"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}
        >
          {MODES.map((m) => {
            const selected = s.series_mode === m.value
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`series-mode-${m.value}`}
                onClick={() => {
                  if (!selected) upd('series_mode', m.value)
                }}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                  padding: '14px 16px',
                  borderRadius: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: selected ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : 'var(--surf-1)',
                  border: `1px solid ${selected ? 'color-mix(in srgb, var(--blue) 45%, transparent)' : 'var(--bord)'}`,
                  color: 'var(--text)',
                }}
              >
                {/* radio ring */}
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 16,
                    height: 16,
                    marginTop: 1,
                    borderRadius: '50%',
                    border: `2px solid ${selected ? 'var(--blue)' : 'var(--bord-3)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {selected && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--blue)' }} />}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: selected ? 'var(--text)' : 'var(--text-2)' }}>{m.title}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.45 }}>{m.desc}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>
                    e.g. {m.example}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isContinuous ? '1fr 110px' : '1fr 110px 1fr',
              gap: 14,
              marginBottom: 14,
            }}
          >
            <div>
              <div className="label">Prefix</div>
              <input className="input" value={s.prefix} onChange={(e) => upd('prefix', e.target.value.toUpperCase())} />
            </div>
            <div>
              <div className="label">Separator</div>
              <select className="input" value={s.separator} onChange={(e) => upd('separator', e.target.value)}>
                {SEQUENCE_SEPARATORS.map((sep) => (
                  <option key={sep || 'none'} value={sep}>
                    {sep === '' ? 'None' : sep}
                  </option>
                ))}
              </select>
            </div>
            {/* The FY token only exists in a financial-year series. */}
            {!isContinuous && (
              <div>
                <div className="label">FY token</div>
                <select className="input" value={s.fy_format} onChange={(e) => upd('fy_format', e.target.value)}>
                  {SEQUENCE_FY_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <div className="label">Pad width</div>
              {/* 0 is never valid for either field, so a cleared field stays
                  blank (with its issue pill) instead of snapping to "0" and
                  turning the next keystroke into "05". */}
              <input
                className="input t-num"
                type="number"
                min={1}
                max={8}
                step={1}
                value={s.zero_padding || ''}
                onChange={(e) => upd('zero_padding', e.target.value)}
              />
            </div>
            <div>
              <div className="label">Starting number</div>
              <input
                className="input t-num"
                type="number"
                min={1}
                step={1}
                value={s.starting_number || ''}
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
              data-testid="numbering-preview"
              style={{
                fontSize: 26,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                fontFamily: 'var(--font-mono)',
                color: issues.length ? 'var(--coral)' : 'var(--text)',
              }}
            >
              {preview}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {issues.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
              <Pill tone="green" icon={<Icon.check size={12} />}>GST Rule 46(b) valid</Pill>
              {warning && (
                <Pill tone="yellow" icon={<Icon.warn size={12} />}>{warning}</Pill>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
              {issues.map((iss, i) => (
                <Pill key={i} tone="coral" icon={<Icon.warn size={12} />}>{iss}</Pill>
              ))}
            </div>
          )}
        </div>

        {/* Switching series: the counter you land on keeps its place. */}
        {continuousUnknown && (
          <div className="t-mute" style={{ fontSize: 11.5, marginBottom: 14 }} data-testid="numbering-resume-note">
            Continues where the continuous series left off — the exact next number is confirmed when you save.
          </div>
        )}
        {resumesPastStart && (
          <div className="t-mute" style={{ fontSize: 11.5, marginBottom: 14 }} data-testid="numbering-resume-note">
            {isContinuous ? 'The continuous' : 'This financial year’s'} series has already issued {issued.toLocaleString('en-IN')}{' '}
            number{issued === 1 ? '' : 's'} — it resumes at {nextNumber(s).toLocaleString('en-IN')}, not at your starting number.
          </div>
        )}

        <div className="t-mute" style={{ fontSize: 11.5, marginBottom: 14 }}>
          A number is issued the moment a draft is created and is never reused — a deleted or cancelled draft still consumes its number.
        </div>

        {/* issued-numbers warning — on the counter the row was running on
            (what the change disturbs) or the one it is moving to. */}
        {touched && (issuedBefore > 0 || issued > 0) && (
          <div
            data-testid="numbering-compliance-banner"
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
              Changing the series, prefix, separator or starting number after numbers have been issued can break GST compliance
              (consecutive numbering). Consult your CA.
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
