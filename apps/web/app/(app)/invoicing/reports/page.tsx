'use client'

import { useState } from 'react'
import { Download, ShieldCheck, Calculator, Clock, RefreshCw, Check } from 'lucide-react'
import { Btn, Pill, SectionHead } from '@/components/proto'
import { InvoPage } from '@/components/invoicing/invo'
import { useToast } from '@/components/ui/use-toast'
import {
  useAging,
  useInvDashboard,
  useTdsReceivable,
  useGenerateGstr1,
  useReportsContext,
  type Gstr1Summary,
} from '@/lib/api/queries/use-invoicing'
import { formatMoney } from '@/lib/invoicing/constants'

const BUCKET_COLORS = ['#27D280', '#FED800', '#FF9933', '#F8786B']

/**
 * Reports hub (global). Universal KPIs (aging, collected) for every country,
 * per a single selected currency (never summed across currencies). India-only
 * GST cards (GSTR-1, TDS) show only for India-based tenants.
 */
export default function InvReportsPage() {
  const { toast } = useToast()
  const { data: ctx } = useReportsContext()
  const baseCurrency = ctx?.data.baseCurrency ?? 'INR'
  const currencies = ctx?.data.currencies ?? ['INR']
  const isIndia = (ctx?.data.countryCode ?? 'IN') === 'IN'

  const [picked, setPicked] = useState<string | null>(null)
  const currency = picked ?? baseCurrency
  const money = (v: string | number) => formatMoney(v, currency)

  const { data: aging } = useAging(currency)
  const { data: dash } = useInvDashboard(currency)
  const { data: tds } = useTdsReceivable()
  const generate = useGenerateGstr1()
  const now = new Date()
  const [summary, setSummary] = useState<Gstr1Summary | null>(null)

  const onExport = async () => {
    try {
      const res = await generate.mutateAsync({ period_month: now.getMonth() + 1, period_year: now.getFullYear() })
      setSummary(res.data.summary)
      const blob = new Blob([JSON.stringify(res.data.payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `gstr1-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: 'GSTR-1 exported', description: `sha256 ${res.data.export.file_hash.slice(0, 16)}…` })
    } catch (err) {
      toast({ title: 'Export failed', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  const buckets = aging?.data.buckets ?? []
  const total = parseFloat(aging?.data.total ?? '0')
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  // Universal KPIs (every country) + India-only GST cards.
  const kpis = [
    ...(isIndia
      ? [
          { t: 'GSTR-1 export', d: `${monthLabel} period file`, icon: ShieldCheck, c: 'var(--coral)', cta: 'Export JSON', onClick: onExport, busy: generate.isPending },
          { t: 'TDS receivable', d: `${formatMoney(tds?.meta.total ?? 0, 'INR')} across ${tds?.meta.count ?? 0} invoices`, icon: Calculator, c: 'var(--blue)', cta: 'Section 393', onClick: undefined, busy: false },
        ]
      : []),
    { t: 'Aging report', d: `${money(total)} outstanding`, icon: Clock, c: 'var(--yellow)', cta: 'Below', onClick: undefined, busy: false },
    { t: 'Collected', d: `${money(dash?.data.collected ?? 0)} · ${dash?.data.paid ?? 0} paid`, icon: RefreshCw, c: 'var(--green)', cta: 'Receivables', onClick: undefined, busy: false },
  ]

  return (
    <InvoPage>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <SectionHead
          title="Invoicing reports"
          sub={isIndia
            ? 'Receivables, revenue & GST — GSTR-1 / TDS for India, Tally & GST-portal compatible.'
            : 'Receivables, revenue & collections across your invoicing currencies.'}
        />
        {currencies.length > 1 && (
          <select
            className="input"
            value={currency}
            onChange={(e) => setPicked(e.target.value)}
            style={{ width: 140, marginTop: 4 }}
            aria-label="Report currency"
          >
            {currencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kpis.length}, 1fr)`, gap: 14, marginBottom: 18, marginTop: 8 }}>
        {kpis.map((r, i) => (
          <div key={i} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: `color-mix(in srgb, ${r.c} 14%, transparent)`, color: r.c, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <r.icon className="w-4 h-4" />
            </div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>{r.t}</div>
              <div className="t-mute" style={{ fontSize: 11.5, marginTop: 2 }}>{r.d}</div>
            </div>
            <Btn kind="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={r.onClick} disabled={!r.onClick || r.busy} style={{ marginTop: 'auto' }}>
              {r.busy ? 'Generating…' : r.cta}
            </Btn>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isIndia ? '1fr 1fr' : '1fr', gap: 16 }}>
        {/* Aging (universal) */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div className="t-h3">Receivables aging · {currency}</div>
            <Pill tone="blue">{money(total)}</Pill>
          </div>
          {total > 0 && (
            <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', marginBottom: 16 }}>
              {buckets.map((b, i) =>
                parseFloat(b.amount) > 0 ? (
                  <div key={b.bucket} style={{ width: `${(parseFloat(b.amount) / total) * 100}%`, background: BUCKET_COLORS[i] }} />
                ) : null,
              )}
            </div>
          )}
          {buckets.map((b, i) => (
            <div key={b.bucket} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--bord)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: BUCKET_COLORS[i] }} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{b.bucket}</span>
              <span className="t-num" style={{ fontSize: 13, fontWeight: 800 }}>{money(b.amount)}</span>
            </div>
          ))}
        </div>

        {/* GSTR-1 summary — India only */}
        {isIndia && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div className="t-h3">GSTR-1 · {monthLabel}</div>
              <Btn kind="primary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={onExport} disabled={generate.isPending}>
                {generate.isPending ? 'Generating…' : 'Export'}
              </Btn>
            </div>
            {summary ? (
              <table className="tbl w-full">
                <thead>
                  <tr><th>Section</th><th style={{ textAlign: 'right' }}>Invoices</th><th style={{ textAlign: 'right' }}>Taxable</th><th style={{ textAlign: 'right' }}>GST</th></tr>
                </thead>
                <tbody>
                  {([
                    ['B2B · 4A', summary.b2b.count, summary.b2b.taxable, summary.b2b.tax],
                    ['B2C large · 5A', summary.b2cl.count, summary.b2cl.taxable, summary.b2cl.tax],
                    ['B2C small · 7', summary.b2cs.count, summary.b2cs.taxable, summary.b2cs.tax],
                    ['Exports · 6A', summary.exp.count, summary.exp.taxable, summary.exp.tax],
                    ['Credit/debit notes · 9B', summary.cdnr.count, summary.cdnr.taxable, '—'],
                  ] as [string, number, string, string][]).map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r[0]}</td>
                      <td style={{ textAlign: 'right' }}>{r[1]}</td>
                      <td className="t-num" style={{ textAlign: 'right', fontWeight: 700 }}>{formatMoney(r[2], 'INR')}</td>
                      <td className="t-num" style={{ textAlign: 'right', fontWeight: 700 }}>{r[3] === '—' ? '—' : formatMoney(r[3], 'INR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="t-mute" style={{ fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
                Run an export to see this month’s section summary.
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 12px', borderRadius: 9, background: 'rgba(39,210,128,.08)', border: '1px solid rgba(39,210,128,.25)' }}>
              <Check className="w-3.5 h-3.5" style={{ color: 'var(--green)' }} />
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
                Sequential numbering enforced at creation · Tally &amp; GST-portal compatible
              </span>
            </div>
          </div>
        )}
      </div>
    </InvoPage>
  )
}
