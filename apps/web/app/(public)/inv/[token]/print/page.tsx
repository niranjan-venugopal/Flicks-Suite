'use client'

import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { InvoiceRenderer } from '@/components/invoicing/InvoiceRenderer'
import { PrintPaymentBlock } from '@/components/invoicing/PrintPaymentBlock'
import { invoiceTheme, type InvoiceThemeName } from '@/components/invoicing/invo'
import { usePublicInvoice } from '@/lib/api/queries/use-invoicing'

/**
 * Print / PDF view of the hosted invoice. InvoicePdfService points headless
 * Chromium here (not at /inv/:token) so the download is a clean document:
 * the shared InvoiceRenderer, but no app chrome, no interactive payment buttons
 * (PrintPaymentBlock shows a static UPI QR + bank details instead), and no
 * view-tracking ping. `?theme=light` switches to the white document variant
 * (default dark). The PDF service waits for [data-invoice-root] before printing,
 * so it only appears once data resolves.
 */
export default function InvoicePrintPage() {
  // useSearchParams() must sit under a Suspense boundary (Next 15 build rule).
  return (
    <Suspense fallback={null}>
      <InvoicePrintInner />
    </Suspense>
  )
}

function InvoicePrintInner() {
  const params = useParams<{ token: string }>()
  const token = params?.token
  const search = useSearchParams()
  const theme: InvoiceThemeName = search?.get('theme') === 'light' ? 'light' : 'dark'
  const t = invoiceTheme(theme)
  const { data, isError } = usePublicInvoice(token)

  return (
    <>
      {/* Full-bleed page: paint html/body so any area below short content (or
          extra pages) stays on-theme instead of white. */}
      <style>{`html,body{background:${t.pageBg};margin:0}`}</style>
      <div
        style={{ background: t.pageBg, padding: '20px' }}
        data-invoice-root={data?.data ? 'ready' : undefined}
      >
        {isError && (
          <div style={{ textAlign: 'center', color: '#F8786B', fontWeight: 600, paddingTop: 80 }}>
            This invoice link is invalid or has expired.
          </div>
        )}
        {data?.data && (
          <>
            <InvoiceRenderer payload={data.data} theme={theme} />
            <PrintPaymentBlock payload={data.data} theme={theme} />
            {data.data.show_powered_by && (
              <div
                style={{
                  textAlign: 'center',
                  marginTop: 20,
                  fontWeight: 600,
                  fontSize: 11,
                  color: t.muted30,
                }}
              >
                Powered by Flicks Suite
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
