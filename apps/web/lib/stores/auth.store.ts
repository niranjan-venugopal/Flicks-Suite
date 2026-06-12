import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type UserRole =
  | 'FAM'
  | 'OWNER'
  | 'HR_ADMIN'
  | 'MANAGER'
  | 'EMPLOYEE'
  | 'AUDITOR'

// Human-readable label for the Topbar / surfaces showing a role.
// HR stays uppercase; everything else is title-cased.
export function roleLabel(role: UserRole | string | null | undefined): string {
  switch (role) {
    case 'FAM':         return 'FAM Admin'
    case 'OWNER':       return 'Owner'
    case 'HR_ADMIN':    return 'HR Admin'
    case 'MANAGER':     return 'Manager'
    case 'EMPLOYEE':    return 'Employee'
    case 'AUDITOR':     return 'Auditor'
    default:            return 'Member'
  }
}

export interface CurrentUser {
  id: string
  name: string
  email: string
  role: UserRole
  avatarUrl?: string
  tenantId: string
  employeeId?: string
}

export interface CurrentTenant {
  id: string
  name: string
  slug: string
  logoUrl?: string
  plan: string
}

interface AuthState {
  currentUser: CurrentUser | null
  currentTenant: CurrentTenant | null
  isAuthenticated: boolean
  isImpersonating: boolean
  impersonatingAs?: string
  setUser: (user: CurrentUser) => void
  setTenant: (tenant: CurrentTenant) => void
  logout: () => void
  startImpersonation: (userId: string) => void
  stopImpersonation: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      currentUser: null,
      currentTenant: null,
      isAuthenticated: false,
      isImpersonating: false,
      impersonatingAs: undefined,

      setUser: (user) => set({ currentUser: user, isAuthenticated: true }),
      setTenant: (tenant) => set({ currentTenant: tenant }),
      logout: () =>
        set({
          currentUser: null,
          currentTenant: null,
          isAuthenticated: false,
          isImpersonating: false,
          impersonatingAs: undefined,
        }),
      startImpersonation: (userId) =>
        set({ isImpersonating: true, impersonatingAs: userId }),
      stopImpersonation: () =>
        set({ isImpersonating: false, impersonatingAs: undefined }),
    }),
    {
      name: 'flicks-auth',
      partialize: (state) => ({
        currentUser: state.currentUser,
        currentTenant: state.currentTenant,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
