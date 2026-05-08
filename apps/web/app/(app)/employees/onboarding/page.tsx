'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'

// TODO: replace with real data from useOnboardingRequests() once the hook ships.
const SAMPLE_ONBOARDINGS = [
  {
    id: 'ob_1',
    name: 'Aanya Kapoor',
    email: 'aanya@example.com',
    department: 'Engineering',
    startDate: '2026-05-12',
  },
  {
    id: 'ob_2',
    name: 'Rohan Mehta',
    email: 'rohan@example.com',
    department: 'Design',
    startDate: '2026-05-15',
  },
  {
    id: 'ob_3',
    name: 'Priya Sharma',
    email: 'priya@example.com',
    department: 'People Ops',
    startDate: '2026-05-20',
  },
]

export default function OnboardingPage() {
  const [items, setItems] = useState(SAMPLE_ONBOARDINGS)

  const handleApprove = (id: string) => {
    // TODO: wire to mutation
    setItems((curr) => curr.filter((i) => i.id !== id))
  }
  const handleReject = (id: string) => {
    // TODO: wire to mutation
    setItems((curr) => curr.filter((i) => i.id !== id))
  }

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-white font-gilroy">Onboarding</h1>
          <p className="text-brand-muted mt-1">
            Approve incoming hires before their first day
          </p>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="All caught up"
              description="There are no onboardings pending your review right now."
            />
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 px-6 py-4 flex-wrap"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-brand-blue/15 border border-brand-blue/30 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-brand-blue font-gilroy">
                        {item.name.charAt(0)}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-white font-gilroy">
                          {item.name}
                        </span>
                        <StatusBadge status="pending" />
                      </div>
                      <div className="text-xs text-white/50 font-gilroy mt-0.5">
                        {item.email} · {item.department} · starts {item.startDate}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReject(item.id)}
                    >
                      <X className="w-3.5 h-3.5" />
                      Reject
                    </Button>
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => handleApprove(item.id)}
                    >
                      <Check className="w-3.5 h-3.5" />
                      Approve
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
