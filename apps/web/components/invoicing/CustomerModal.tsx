'use client'

import { useEffect, useState } from 'react'
import { InvoBtn, invoSelectReset } from '@/components/invoicing/invo'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  useSaveCustomer,
  type Customer,
  type CustomerInput,
} from '@/lib/api/queries/use-invoicing'
import { COUNTRIES, IN_STATE_CODES } from '@/lib/countries'
import { SUPPORTED_CURRENCY_CODES } from '@/lib/invoicing/constants'
import { stateName } from '@flicks/shared/constants'

const FIELD: React.CSSProperties = {
  width: '100%',
  height: 44,
  background: 'rgba(255,255,255,0.05)',
  border: '1.5px solid rgba(255,255,255,0.10)',
  borderRadius: 10,
  padding: '0 14px',
  fontWeight: 600,
  fontSize: 14,
  color: '#fff',
  outline: 'none',
  letterSpacing: '-0.02em',
}
const LABEL: React.CSSProperties = {
  display: 'block',
  fontWeight: 700,
  fontSize: 13,
  color: 'rgba(255,255,255,0.6)',
  marginBottom: 6,
  letterSpacing: '-0.02em',
}
const HINT: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.42)',
  marginTop: 5,
  lineHeight: 1.45,
}

// Same rule the API enforces (packages/shared GSTIN_RE) — checked here too so
// a typo is caught before the round trip.
const GSTIN_RE =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/

/**
 * The one client form (round 18). Country drives everything: India asks for a
 * GST state + GSTIN/PAN, everywhere else asks for a free-text state and a
 * VAT/Tax ID, because a foreign client has no GSTIN — that supply is an
 * export of services, zero-rated, and the invoice carries the LUT endorsement
 * instead of GST.
 *
 * The billing address is not optional polish: Rule 46 makes the recipient's
 * name, address and state mandatory on a tax invoice.
 */
export function CustomerModal({
  open,
  onOpenChange,
  customer,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  customer?: Customer | null
  /** Fires with the saved client — lets the invoice editor select it. */
  onCreated?: (c: Customer) => void
}) {
  const { toast } = useToast()
  const save = useSaveCustomer()
  const [form, setForm] = useState<CustomerInput>({
    display_name: '',
    country_code: 'IN',
  })

  useEffect(() => {
    if (!open) return
    setForm(
      customer
        ? {
            display_name: customer.display_name,
            legal_name: customer.legal_name ?? '',
            email: customer.email ?? '',
            phone: customer.phone ?? '',
            gstin: customer.gstin ?? '',
            pan: customer.pan ?? '',
            intl_tax_id: customer.intl_tax_id ?? '',
            country_code: customer.country_code ?? 'IN',
            state_code: customer.state_code ?? '',
            billing_address_line1: customer.billing_address_line1 ?? '',
            billing_address_line2: customer.billing_address_line2 ?? '',
            billing_city: customer.billing_city ?? '',
            billing_state: customer.billing_state ?? '',
            billing_postal_code: customer.billing_postal_code ?? '',
            default_currency: customer.default_currency ?? 'INR',
          }
        : { display_name: '', country_code: 'IN', default_currency: 'INR' },
    )
  }, [open, customer])

  const set =
    (k: keyof CustomerInput) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const isIndia = (form.country_code ?? 'IN') === 'IN'

  // Switching away from India clears the Indian-only tax identifiers rather
  // than silently shipping a GSTIN the server would reject.
  const onCountryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const country_code = e.target.value
    setForm((f) => ({
      ...f,
      country_code,
      ...(country_code === 'IN'
        ? { intl_tax_id: '' }
        : { gstin: '', pan: '', state_code: '' }),
    }))
  }

  const onSubmit = async () => {
    if (!form.display_name.trim()) {
      toast({ title: 'Display name is required', variant: 'destructive' })
      return
    }
    if (isIndia && form.gstin?.trim() && !GSTIN_RE.test(form.gstin.trim().toUpperCase())) {
      toast({
        title: 'That GSTIN does not look right',
        description: 'Format: 29ABCDE1234F1Z5 — 15 characters.',
        variant: 'destructive',
      })
      return
    }
    try {
      const saved = await save.mutateAsync({
        id: customer?.id,
        ...form,
        gstin: form.gstin?.trim().toUpperCase() || '',
        pan: form.pan?.trim().toUpperCase() || '',
        // country_code is the single source of truth for tax treatment;
        // billing_country is kept in step so the printed address matches.
        billing_country: form.country_code,
      })
      toast({ title: customer ? 'Client updated' : 'Client created' })
      if (!customer && saved?.data) onCreated?.(saved.data)
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Could not save client',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{customer ? 'Edit client' : 'New client'}</DialogTitle>
        </DialogHeader>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 14,
            padding: '4px 0',
            maxHeight: '65vh',
            overflowY: 'auto',
          }}
        >
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Display name *</label>
            <input style={FIELD} value={form.display_name} onChange={set('display_name')} placeholder="Acme Corp" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Legal name</label>
            <input style={FIELD} value={form.legal_name ?? ''} onChange={set('legal_name')} />
          </div>
          <div>
            <label style={LABEL}>Email</label>
            <input style={FIELD} value={form.email ?? ''} onChange={set('email')} type="email" />
          </div>
          <div>
            <label style={LABEL}>Phone</label>
            <input style={FIELD} value={form.phone ?? ''} onChange={set('phone')} />
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Country *</label>
            <select
              style={{ ...FIELD, ...invoSelectReset }}
              value={form.country_code ?? 'IN'}
              onChange={onCountryChange}
            >
              {COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            {!isIndia && (
              <div style={{ ...HINT, color: 'rgba(120,190,255,0.85)' }}>
                Export client — no GST is charged. The invoice prints the
                export declaration instead. Set your LUT number in
                Invoicing → Settings → Compliance.
              </div>
            )}
          </div>

          {/* ─── Billing address (Rule 46: mandatory on a tax invoice) ─── */}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={LABEL}>Billing address</label>
            <input
              style={FIELD}
              value={form.billing_address_line1 ?? ''}
              onChange={set('billing_address_line1')}
              placeholder="Address line 1"
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <input
              style={FIELD}
              value={form.billing_address_line2 ?? ''}
              onChange={set('billing_address_line2')}
              placeholder="Address line 2 (optional)"
            />
          </div>
          <div>
            <label style={LABEL}>City</label>
            <input style={FIELD} value={form.billing_city ?? ''} onChange={set('billing_city')} />
          </div>
          <div>
            <label style={LABEL}>Postal code</label>
            <input style={FIELD} value={form.billing_postal_code ?? ''} onChange={set('billing_postal_code')} />
          </div>

          <div>
            <label style={LABEL}>State</label>
            {isIndia ? (
              /* Code-valued select — free text here used to silently break the
                 CGST/SGST-vs-IGST derivation, which compares 2-letter codes. */
              <select style={{ ...FIELD, ...invoSelectReset }} value={form.state_code ?? ''} onChange={set('state_code')}>
                <option value="">Select…</option>
                {IN_STATE_CODES.map((c) => (
                  <option key={c} value={c}>
                    {stateName(c)}
                  </option>
                ))}
                {/* Keep a legacy free-text value selectable so old customers stay editable */}
                {form.state_code && !(IN_STATE_CODES as readonly string[]).includes(form.state_code) && (
                  <option value={form.state_code}>{stateName(form.state_code)}</option>
                )}
              </select>
            ) : (
              <input
                style={FIELD}
                value={form.billing_state ?? ''}
                onChange={set('billing_state')}
                placeholder="State / province"
              />
            )}
          </div>
          <div>
            <label style={LABEL}>Default currency</label>
            <select style={{ ...FIELD, ...invoSelectReset }} value={form.default_currency ?? 'INR'} onChange={set('default_currency')}>
              {SUPPORTED_CURRENCY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {!isIndia && (form.default_currency ?? 'INR') === 'INR' && (
              <div style={HINT}>Most export clients are billed in their own currency.</div>
            )}
          </div>

          {/* ─── Tax identifiers, by country ─── */}
          {isIndia ? (
            <>
              <div>
                <label style={LABEL}>GSTIN</label>
                <input
                  style={FIELD}
                  value={form.gstin ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                  placeholder="29ABCDE1234F1Z5"
                />
              </div>
              <div>
                <label style={LABEL}>PAN</label>
                <input
                  style={FIELD}
                  value={form.pan ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase() }))}
                  placeholder="ABCDE1234F"
                />
              </div>
            </>
          ) : (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={LABEL}>VAT / Tax ID (optional)</label>
              <input style={FIELD} value={form.intl_tax_id ?? ''} onChange={set('intl_tax_id')} />
              <div style={HINT}>
                A client outside India has no GSTIN, so that field is not asked for.
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <InvoBtn kind="outline" height={44} onClick={() => onOpenChange(false)}>
            Cancel
          </InvoBtn>
          <InvoBtn kind="primary" height={44} onClick={onSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : customer ? 'Save changes' : 'Create client'}
          </InvoBtn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
