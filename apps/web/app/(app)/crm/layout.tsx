import { CrmSearchPalette } from '@/components/crm/CrmSearchPalette'
import { QuickAddGlobal } from '@/components/crm/QuickAdd'

/**
 * CRM section layout — mounts the ⌘K// global search palette (§19.8) and the
 * C7 quick-add (N) across every CRM page. Both are invisible until summoned.
 */
export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CrmSearchPalette />
      <QuickAddGlobal />
    </>
  )
}
