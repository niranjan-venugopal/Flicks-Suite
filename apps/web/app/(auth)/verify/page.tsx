'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { CheckCircle2, RefreshCw, ShieldAlert, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageGlows } from '@/components/layout/PageGlows'
import { useVerifyMagicLinkQuery } from '@/lib/api/queries/use-auth'

export default function VerifyMagicLinkPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const { isLoading, isSuccess, isError, error } = useVerifyMagicLinkQuery(token)

  useEffect(() => {
    if (isSuccess) {
      const timeout = setTimeout(() => {
        router.replace('/dashboard')
      }, 800)
      return () => clearTimeout(timeout)
    }
  }, [isSuccess, router])

  const renderState = () => {
    if (!token) {
      return (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-coral/15">
            <ShieldAlert className="h-6 w-6 text-brand-coral" />
          </div>
          <h1 className="text-2xl font-bold text-white font-gilroy mb-2">Missing token</h1>
          <p className="text-brand-muted text-sm mb-6">
            This link is missing the verification token. Please request a new one.
          </p>
          <Link href="/login">
            <Button className="w-full h-12 bg-brand-blue hover:bg-brand-blue/90 text-white font-semibold shadow-glow-blue transition-all">
              Back to sign in
            </Button>
          </Link>
        </div>
      )
    }

    if (isLoading) {
      return (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-blue/15">
            <RefreshCw className="h-6 w-6 text-brand-blue animate-spin" />
          </div>
          <h1 className="text-2xl font-bold text-white font-gilroy mb-2">
            Verifying your link
          </h1>
          <p className="text-brand-muted text-sm">
            Hang tight while we sign you in securely...
          </p>
        </div>
      )
    }

    if (isSuccess) {
      return (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-green/15">
            <CheckCircle2 className="h-6 w-6 text-brand-green" />
          </div>
          <h1 className="text-2xl font-bold text-white font-gilroy mb-2">You're in</h1>
          <p className="text-brand-muted text-sm">Redirecting to your dashboard...</p>
        </div>
      )
    }

    if (isError) {
      return (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-coral/15">
            <ShieldAlert className="h-6 w-6 text-brand-coral" />
          </div>
          <h1 className="text-2xl font-bold text-white font-gilroy mb-2">
            Link expired or invalid
          </h1>
          <p className="text-brand-muted text-sm mb-6">
            {error instanceof Error
              ? error.message
              : 'This magic link is no longer valid. Request a new one to continue.'}
          </p>
          <Link href="/login">
            <Button className="w-full h-12 bg-brand-blue hover:bg-brand-blue/90 text-white font-semibold shadow-glow-blue transition-all">
              Back to sign in
            </Button>
          </Link>
        </div>
      )
    }

    return null
  }

  return (
    <div className="relative min-h-screen bg-brand-bg flex items-center justify-center overflow-hidden">
      <PageGlows variant="auth" />

      <div className="relative z-10 w-full max-w-md px-4">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-10 h-10 bg-brand-blue rounded-xl flex items-center justify-center shadow-glow-blue">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <span className="text-2xl font-bold text-white">
              flicks<span className="text-brand-blue">.</span>
            </span>
          </div>
          <p className="text-brand-muted text-sm">HR that works at startup speed</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass rounded-xl p-8"
        >
          {renderState()}
        </motion.div>
      </div>
    </div>
  )
}
