'use client'

import { PmProvider } from '@/lib/pm/PmProvider'
import { PmGlobalKeys } from '@/components/pm/palette'

/** PM area layout — mounts the FSE engine + palette/keymap keys once. */
export default function PmLayout({ children }: { children: React.ReactNode }) {
  return (
    <PmProvider>
      {children}
      <PmGlobalKeys />
    </PmProvider>
  )
}
