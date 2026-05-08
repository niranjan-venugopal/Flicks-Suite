'use client'

import { use } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Briefcase,
  Mail,
  Phone,
  MapPin,
  Calendar,
  FileText,
  History,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useEmployee } from '@/lib/api/queries/use-employees'

export default function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const { data: employee, isLoading } = useEmployee(id)

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <Link
            href="/employees"
            className="inline-flex items-center gap-2 text-sm text-white/50 hover:text-white/80 font-gilroy transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to employees
          </Link>
        </motion.div>

        {isLoading ? (
          <div className="glass rounded-xl py-16 text-center text-white/50 font-gilroy text-sm">
            Loading employee...
          </div>
        ) : !employee ? (
          <div className="glass rounded-xl">
            <EmptyState
              icon={User}
              title="Employee not found"
              description="The employee you’re looking for may have been removed."
            />
          </div>
        ) : (
          <>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass rounded-xl p-6 mb-6 flex items-start justify-between gap-6 flex-wrap"
            >
              <div className="flex items-center gap-5">
                <div className="w-16 h-16 rounded-xl bg-brand-blue/15 border border-brand-blue/30 flex items-center justify-center">
                  <span className="text-2xl font-bold text-brand-blue font-gilroy">
                    {employee.name.charAt(0)}
                  </span>
                </div>
                <div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <h1 className="text-2xl font-bold text-white font-gilroy">
                      {employee.name}
                    </h1>
                    <StatusBadge status={employee.status} />
                  </div>
                  <p className="text-brand-muted text-sm mt-1">
                    {employee.designation ?? 'Team member'}
                    {employee.employeeCode ? ` · ${employee.employeeCode}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm">
                  Message
                </Button>
                <Button size="sm">Edit</Button>
              </div>
            </motion.div>

            <Tabs defaultValue="profile" className="w-full">
              <TabsList>
                <TabsTrigger value="profile">
                  <User className="w-3.5 h-3.5 mr-1.5" />
                  Profile
                </TabsTrigger>
                <TabsTrigger value="documents">
                  <FileText className="w-3.5 h-3.5 mr-1.5" />
                  Documents
                </TabsTrigger>
                <TabsTrigger value="history">
                  <History className="w-3.5 h-3.5 mr-1.5" />
                  History
                </TabsTrigger>
              </TabsList>

              <TabsContent value="profile">
                <div className="glass rounded-xl p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Field icon={Mail} label="Email" value={employee.email} />
                  <Field
                    icon={Phone}
                    label="Phone"
                    value={employee.phone ?? '—'}
                  />
                  <Field
                    icon={Briefcase}
                    label="Department"
                    value={employee.department ?? '—'}
                  />
                  <Field
                    icon={MapPin}
                    label="Location"
                    value={employee.location ?? '—'}
                  />
                  <Field
                    icon={Calendar}
                    label="Join date"
                    value={employee.joinDate ?? '—'}
                  />
                  <Field
                    icon={User}
                    label="Reporting manager"
                    value={employee.reportingManager?.name ?? '—'}
                  />
                </div>
              </TabsContent>

              <TabsContent value="documents">
                <div className="glass rounded-xl">
                  <EmptyState
                    icon={FileText}
                    title="No documents uploaded"
                    description="Offer letters, ID proofs and contracts will appear here once added."
                  />
                </div>
              </TabsContent>

              <TabsContent value="history">
                <div className="glass rounded-xl">
                  <EmptyState
                    icon={History}
                    title="No history yet"
                    description="Role changes, promotions and salary revisions will be tracked here."
                  />
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  )
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-white/50" />
      </div>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wider text-white/40 font-gilroy">
          {label}
        </div>
        <div className="text-sm text-white font-gilroy mt-0.5 break-words">
          {value}
        </div>
      </div>
    </div>
  )
}
