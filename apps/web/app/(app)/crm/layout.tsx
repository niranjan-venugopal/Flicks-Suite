import { CrmSearchPalette } from '@/components/crm/CrmSearchPalette'

/**
 * CRM section layout — mounts the ⌘K global search palette (PRD v5 §19.8) across
 * every CRM page. The palette is invisible until summoned, so it adds no chrome.
 */
export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CrmSearchPalette />
    </>
  )
}
