'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // The devtools mount a floating button on every route. Hide it on the print
  // view so it never lands in a rendered invoice PDF (InvoicePdfService renders
  // /inv/:token/print through headless Chromium).
  const isPrint = pathname?.includes('/print') ?? false
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Perf pass (2026-07-11): cached data serves navigations instantly.
            // 5-min staleness is fine for HRMS/invoicing lists; mutations
            // invalidate their own keys, and focus-refetch was causing a
            // spinner storm on every tab/window switch.
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {!isPrint && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  )
}
