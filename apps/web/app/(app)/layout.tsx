'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useCurrentUser } from '@/lib/api/queries/use-auth'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated } = useAuthStore()
  const { isLoading, isError } = useCurrentUser()

  useEffect(() => {
    if (!isLoading && (isError || !isAuthenticated)) {
      router.replace('/login')
    }
  }, [isLoading, isError, isAuthenticated, router])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-brand-bg">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
