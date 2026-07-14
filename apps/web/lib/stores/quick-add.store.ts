import { create } from 'zustand'

export type QuickAddKind = 'deal' | 'person' | 'company'

interface QuickAddState {
  open: boolean
  kind: QuickAddKind
  openWith: (kind?: QuickAddKind) => void
  close: () => void
}

/**
 * C7 — global quick-add ("press N anywhere in CRM, ≤2 interactions to a deal").
 * Pages trigger it via openWith(); the modal itself is mounted once in the CRM
 * section layout.
 */
export const useQuickAdd = create<QuickAddState>((set) => ({
  open: false,
  kind: 'deal',
  openWith: (kind = 'deal') => set({ open: true, kind }),
  close: () => set({ open: false }),
}))
