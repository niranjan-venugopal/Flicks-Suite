import type { Metadata } from 'next'
import './globals.css'
import { QueryProvider } from '@/components/providers/QueryProvider'
import { PostHogProvider } from '@/components/providers/PostHogProvider'
import { Toaster } from '@/components/ui/toaster'
import { ConsentBanner } from '@/components/consent/ConsentBanner'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.flickssuite.com'

// SEO defaults (round 7): Specflicks + Flicks Suite branding, absolute URLs
// via metadataBase, OG card. Per-route layouts (login/onboarding/legal)
// override title/description/keywords; app/icon.png is the auto-favicon.
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: 'Flicks Suite HRMS', template: '%s · Flicks Suite' },
  description:
    'Flicks Suite by Specflicks — HRMS, CRM, invoicing and project management for Indian startups, in one suite.',
  keywords: [
    'Specflicks',
    'Flicks Suite',
    'HRMS',
    'CRM',
    'invoicing',
    'project management',
    'payroll',
    'attendance',
    'India',
  ],
  applicationName: 'Flicks Suite',
  openGraph: {
    siteName: 'Flicks Suite',
    type: 'website',
    url: '/',
    title: 'Flicks Suite HRMS',
    description: 'HRMS, CRM, invoicing and project management by Specflicks.',
    images: ['/og.png'],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-gilroy bg-brand-bg text-brand-text antialiased">
        <QueryProvider>
          <PostHogProvider>
            {children}
            <Toaster />
            {/* D1 — geo-aware consent banner; self-hides on print/public pages */}
            <ConsentBanner />
          </PostHogProvider>
        </QueryProvider>
      </body>
    </html>
  )
}
