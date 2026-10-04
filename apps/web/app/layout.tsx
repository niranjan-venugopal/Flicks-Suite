import type { Metadata } from 'next'
import './globals.css'
import { QueryProvider } from '@/components/providers/QueryProvider'
import { PostHogProvider } from '@/components/providers/PostHogProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { PRE_PAINT_SCRIPT } from '@/lib/theme/theme'
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
  // Round O theme: <html data-theme> carries the resolved theme. The SSR
  // default is dark (existing users keep dark); the inline script — FIRST
  // child of <body>, CSP allows 'unsafe-inline' — swaps it from the device
  // mirror / prefers-color-scheme before anything paints, and
  // suppressHydrationWarning covers the attribute React did not render.
  // The body classes resolve through the CSS tokens now (tailwind.config.ts).
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="font-gilroy bg-brand-bg text-brand-text antialiased">
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_SCRIPT }} />
        <QueryProvider>
          <ThemeProvider />
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
