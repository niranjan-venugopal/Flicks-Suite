'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Search, UserPlus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useEmployees, type Employee } from '@/lib/api/queries/use-employees'
import { cn } from '@/lib/utils'

const STATUS_FILTERS: Array<{ label: string; value: '' | 'active' | 'inactive' | 'on_leave' }> = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'active' },
  { label: 'On leave', value: 'on_leave' },
  { label: 'Inactive', value: 'inactive' },
]

export default function EmployeesPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | 'active' | 'inactive' | 'on_leave'>('')

  const { data, isLoading } = useEmployees({
    search: search || undefined,
    status: status || undefined,
  })

  const employees: Employee[] = data?.employees ?? []

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 mb-8"
        >
          <div>
            <h1 className="text-3xl font-bold text-white font-gilroy">Employees</h1>
            <p className="text-brand-muted mt-1">
              Manage your team, roles and reporting structure
            </p>
          </div>
          <Button className="shrink-0">
            <UserPlus className="w-4 h-4" />
            Invite employee
          </Button>
        </motion.div>

        <div className="glass rounded-xl p-5 mb-6">
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email or code"
                className="pl-10"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.label}
                  onClick={() => setStatus(f.value)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-xs font-semibold font-gilroy transition-all duration-200 border',
                    status === f.value
                      ? 'bg-brand-blue/15 border-brand-blue/40 text-brand-blue'
                      : 'bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10'
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="glass rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="py-16 text-center text-white/50 font-gilroy text-sm">
              Loading employees...
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No employees yet"
              description="Invite your first teammate to get started building your workspace."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06] text-left">
                    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider">
                      Code
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider">
                      Department
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider">
                      Manager
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => (
                    <tr
                      key={emp.id}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-white font-gilroy">
                            {emp.name}
                          </span>
                          <span className="text-xs text-white/40 font-gilroy">{emp.email}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                        {emp.employeeCode ?? '—'}
                      </td>
                      <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                        {emp.department ?? '—'}
                      </td>
                      <td className="px-6 py-4 text-sm text-white/70 font-gilroy">
                        {emp.reportingManager?.name ?? '—'}
                      </td>
                      <td className="px-6 py-4">
                        <StatusBadge status={emp.status} />
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Link href={`/employees/${emp.id}`}>
                          <Button variant="ghost" size="sm">
                            View
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
