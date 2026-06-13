'use client'

import { INVO, InvoAvatar, StatusChip } from '@/components/invoicing/invo'
import type { PublicInvoicePayload } from '@/lib/api/queries/use-invoicing'

/**
 * Shared invoice renderer (PRD §9.2): ONE component renders the in-app
 * full-page preview and the hosted public page, so the two can never drift.
 * Takes the public payload shape; the preview page adapts the authed
 * InvoiceDetail into this shape.
 */

const symbol = (c: string) => (c === 'INR' ? '₹' : c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : `${c} `)
const money = (v: string | null | undefined, c: string) => {
  const n = parseFloat(v ?? '0')
  return `${symbol(c)}${Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : v}`
}
const dateFmt = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

const label: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 11,
  color: INVO.muted40,
  letterSpacing: '-0.01em',
  textTransform: 'uppercase',
  marginBottom: 6,
}
const th: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 12,
  color: INVO.muted40,
  letterSpacing: '-0.01em',
  padding: '12px 10px',
  textAlign: 'left',
}
const td: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  color: '#fff',
  letterSpacing: '-0.02em',
  padding: '14px 10px',
  verticalAlign: 'top',
}
const sumLabel: React.CSSProperties = { fontWeight: 600, fontSize: 14, color: INVO.muted50, letterSpacing: '-0.02em' }
const sumValue: React.CSSProperties = { fontWeight: 700, fontSize: 14, color: '#fff', letterSpacing: '-0.02em' }

function Address({ lines }: { lines: (string | null | undefined)[] }) {
  const present = lines.filter(Boolean)
  if (!present.length) return null
  return (
    <div style={{ fontWeight: 600, fontSize: 13, color: INVO.muted60, lineHeight: 1.5, letterSpacing: '-0.02em' }}>
      {present.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

export function InvoiceRenderer({ payload }: { payload: PublicInvoicePayload }) {
  const { invoice, line_items, customer, seller } = payload
  const cur = invoice.currency
  // GST + TDS are India-only — non-INR invoices render neither (matches the editor).
  const isDomestic = (cur ?? 'INR') === 'INR'
  const isIntra = invoice.tax_treatment === 'INTRA_STATE' && isDomestic
  const tdsCents = isDomestic ? Math.round(parseFloat(invoice.tds_amount ?? '0') * 100) : 0

  return (
    <div
      style={{
        maxWidth: 820,
        margin: '0 auto',
        background: INVO.cardBgStrong,
        borderRadius: 16,
        padding: '40px 44px',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Header: seller + invoice meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 36 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          {seller?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={seller.logo_url} alt="" style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'cover' }} />
          ) : (
            <InvoAvatar name={seller?.name ?? 'Co'} size={48} />
          )}
          <div>
            <div style={{ fontWeight: 700, fontSize: 20, color: '#fff', letterSpacing: '-0.02em' }}>
              {seller?.legal_name ?? seller?.name ?? '—'}
            </div>
            <Address
              lines={[
                seller?.address_line1,
                seller?.address_line2,
                [seller?.city, seller?.state_code, seller?.postal_code].filter(Boolean).join(', ') || null,
                seller?.gstin ? `GSTIN: ${seller.gstin}` : null,
              ]}
            />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, fontSize: 26, color: '#fff', letterSpacing: '-0.04em', marginBottom: 6 }}>
            INVOICE
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, color: INVO.muted60, letterSpacing: '-0.02em', marginBottom: 8 }}>
            {invoice.invoice_number}
          </div>
          <StatusChip status={invoice.status} />
        </div>
      </div>

      {/* Bill-to + dates */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 32, marginBottom: 32 }}>
        <div>
          <div style={label}>Billed to</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff', letterSpacing: '-0.02em', marginBottom: 4 }}>
            {customer?.legal_name ?? customer?.display_name ?? '—'}
          </div>
          <Address
            lines={[
              customer?.billing_address_line1,
              customer?.billing_address_line2,
              [customer?.billing_city, customer?.billing_state, customer?.billing_postal_code].filter(Boolean).join(', ') || null,
              customer?.billing_country,
              customer?.gstin ? `GSTIN: ${customer.gstin}` : null,
            ]}
          />
        </div>
        <div>
          <div style={label}>Issue date</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#fff' }}>{dateFmt(invoice.invoice_date)}</div>
          {invoice.reference && (
            <>
              <div style={{ ...label, marginTop: 14 }}>Reference</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#fff' }}>{invoice.reference}</div>
            </>
          )}
        </div>
        <div>
          <div style={label}>Due date</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#fff' }}>{dateFmt(invoice.due_date)}</div>
          {invoice.place_of_supply && (
            <>
              <div style={{ ...label, marginTop: 14 }}>Place of supply</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#fff' }}>{invoice.place_of_supply}</div>
            </>
          )}
        </div>
      </div>

      {/* Line items */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 24 }}>
        <thead>
          <tr style={{ borderBottom: INVO.headBorder, borderTop: INVO.headBorder }}>
            <th style={{ ...th, width: '44%' }}>Description</th>
            <th style={th}>HSN/SAC</th>
            <th style={{ ...th, textAlign: 'right' }}>Qty</th>
            <th style={{ ...th, textAlign: 'right' }}>Rate</th>
            {isDomestic && <th style={{ ...th, textAlign: 'right' }}>GST %</th>}
            <th style={{ ...th, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {line_items.map((l) => (
            <tr key={l.line_number} style={{ borderBottom: INVO.rowBorder }}>
              <td style={td}>
                <div style={{ fontWeight: 700 }}>{l.item_name}</div>
                {l.description && (
                  <div style={{ fontWeight: 600, fontSize: 12, color: INVO.muted40, marginTop: 2 }}>{l.description}</div>
                )}
              </td>
              <td style={{ ...td, color: INVO.muted60 }}>{l.hsn_sac_code ?? '—'}</td>
              <td style={{ ...td, textAlign: 'right', color: INVO.muted60 }}>
                {parseFloat(l.quantity).toLocaleString('en-IN')}
                {l.unit ? ` ${l.unit}` : ''}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{money(l.rate, cur)}</td>
              {isDomestic && <td style={{ ...td, textAlign: 'right', color: INVO.muted60 }}>{l.gst_rate ?? '0'}</td>}
              <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(l.taxable_amount ?? l.rate, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 28 }}>
        <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={sumLabel}>Subtotal</span>
            <span style={sumValue}>{money(invoice.subtotal, cur)}</span>
          </div>
          {parseFloat(invoice.discount_amount ?? '0') > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={sumLabel}>Discount</span>
              <span style={{ ...sumValue, color: INVO.coral }}>− {money(invoice.discount_amount, cur)}</span>
            </div>
          )}
          {isDomestic && (isIntra ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={sumLabel}>CGST</span>
                <span style={sumValue}>{money(invoice.cgst_amount, cur)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={sumLabel}>SGST</span>
                <span style={sumValue}>{money(invoice.sgst_amount, cur)}</span>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={sumLabel}>{invoice.tax_treatment === 'EXPORT' ? 'IGST (zero-rated export)' : 'IGST'}</span>
              <span style={sumValue}>{money(invoice.igst_amount, cur)}</span>
            </div>
          ))}
          {isDomestic && parseFloat(invoice.cess_amount ?? '0') > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={sumLabel}>Cess</span>
              <span style={sumValue}>{money(invoice.cess_amount, cur)}</span>
            </div>
          )}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 700, fontSize: 16, color: '#fff', letterSpacing: '-0.02em' }}>Total</span>
            <span style={{ fontWeight: 700, fontSize: 24, color: '#fff', letterSpacing: '-0.04em' }}>
              {money(invoice.total_amount, cur)}
            </span>
          </div>
          {tdsCents > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={sumLabel}>
                  TDS {invoice.tds_section ? `(S.${invoice.tds_section}` : ''}
                  {invoice.tds_rate ? ` @ ${invoice.tds_rate}%` : ''}
                  {invoice.tds_section ? ')' : ''}
                </span>
                <span style={{ ...sumValue, color: INVO.coral }}>− {money(invoice.tds_amount, cur)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...sumLabel, color: INVO.blue, fontWeight: 700 }}>Net receivable</span>
                <span style={{ ...sumValue, color: INVO.blue, fontSize: 16 }}>{money(invoice.net_receivable, cur)}</span>
              </div>
            </>
          )}
          {parseFloat(invoice.amount_paid ?? '0') > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={sumLabel}>Paid</span>
                <span style={{ ...sumValue, color: INVO.green }}>{money(invoice.amount_paid, cur)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...sumLabel, fontWeight: 700 }}>Balance due</span>
                <span style={{ ...sumValue, fontSize: 16 }}>{money(invoice.amount_outstanding, cur)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Notes / T&C */}
      {(invoice.notes || invoice.terms_and_conditions) && (
        <div style={{ borderTop: INVO.rowBorder, paddingTop: 20, display: 'grid', gap: 16 }}>
          {invoice.notes && (
            <div>
              <div style={label}>Notes</div>
              <div style={{ fontWeight: 600, fontSize: 13, color: INVO.muted60, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {invoice.notes}
              </div>
            </div>
          )}
          {invoice.terms_and_conditions && (
            <div>
              <div style={label}>Terms & conditions</div>
              <div style={{ fontWeight: 600, fontSize: 13, color: INVO.muted50, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {invoice.terms_and_conditions}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
