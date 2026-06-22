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
            staleTime: 60 * 1000,
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
