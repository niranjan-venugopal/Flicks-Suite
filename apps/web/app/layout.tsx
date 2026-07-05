import type { Metadata } from 'next'
import './globals.css'
import { QueryProvider } from '@/components/providers/QueryProvider'
import { PostHogProvider } from '@/components/providers/PostHogProvider'
import { Toaster } from '@/components/ui/toaster'
import { ConsentBanner } from '@/components/consent/ConsentBanner'

export const metadata: Metadata = {
  title: 'Flicks Suite HRMS',
  description: 'HR that works at startup speed',
  icons: {
    icon: '/favicon.ico',
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
