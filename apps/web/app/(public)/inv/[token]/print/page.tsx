'use client'

import { useParams } from 'next/navigation'
import { InvoiceRenderer } from '@/components/invoicing/InvoiceRenderer'
import { PrintPaymentBlock } from '@/components/invoicing/PrintPaymentBlock'
import { INVO } from '@/components/invoicing/invo'
import { usePublicInvoice } from '@/lib/api/queries/use-invoicing'

/**
 * Print / PDF view of the hosted invoice. InvoicePdfService points headless
 * Chromium here (not at /inv/:token) so the download is a clean document:
 * same dark theme + the shared InvoiceRenderer, but no app chrome, no
 * interactive payment buttons (PrintPaymentBlock shows a static UPI QR + bank
 * details instead), and no view-tracking ping. The PDF service waits for
 * [data-invoice-root] before printing, so it only appears once data resolves.
 */
export default function InvoicePrintPage() {
  const params = useParams<{ token: string }>()
  const token = params?.token
  const { data, isError } = usePublicInvoice(token)

  return (
    <>
      {/* Full-bleed dark page: paint html/body so any area below short content
          (or extra pages) stays on-theme instead of white. */}
      <style>{`html,body{background:#01010D;margin:0}`}</style>
      <div
        style={{ background: '#01010D', padding: '20px' }}
        data-invoice-root={data?.data ? 'ready' : undefined}
      >
        {isError && (
          <div style={{ textAlign: 'center', color: INVO.coral, fontWeight: 600, paddingTop: 80 }}>
            This invoice link is invalid or has expired.
          </div>
        )}
        {data?.data && (
          <>
            <InvoiceRenderer payload={data.data} />
            <PrintPaymentBlock payload={data.data} />
            {data.data.show_powered_by && (
              <div
                style={{
                  textAlign: 'center',
                  marginTop: 20,
                  fontWeight: 600,
                  fontSize: 11,
                  color: INVO.muted30,
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
