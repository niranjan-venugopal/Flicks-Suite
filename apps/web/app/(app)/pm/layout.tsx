'use client'

import { PmProvider } from '@/lib/pm/PmProvider'

/** PM area layout — mounts the FSE engine once for every /pm route. */
export default function PmLayout({ children }: { children: React.ReactNode }) {
  return <PmProvider>{children}</PmProvider>
}
