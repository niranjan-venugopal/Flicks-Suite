'use client'

import { motion } from 'framer-motion'
import { FileText } from 'lucide-react'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { ComingSoon } from '@/components/crm/ComingSoon'
import { Icon } from '@/components/proto'
import { FEATURES } from '@/lib/feature-flags'

export default function EmployeeDocumentsPage() {
  if (!FEATURES.hr_documents) {
    return (
      <ComingSoon
        title="Documents"
        line="A central vault for offer letters, contracts and identity proofs — per-employee folders, controlled sharing, and expiry reminders. We're building the storage side now."
        icon={<Icon.doc size={24} />}
        bullets={[
          'Per-employee folders with role-based access',
          'Offer letters, contracts and ID proofs in one place',
          'Expiry reminders for time-bound documents',
        ]}
      />
    )
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
          <h1 className="text-3xl font-bold text-white font-gilroy">Documents</h1>
          <p className="text-brand-muted mt-1">
            Centralised storage for offer letters, contracts and identity proofs
          </p>
        </motion.div>

        <div className="glass rounded-xl">
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Upload your first document to start building a searchable archive."
          />
        </div>
      </div>
    </div>
  )
}
