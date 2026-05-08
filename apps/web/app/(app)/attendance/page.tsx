'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Clock, LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageGlows } from '@/components/layout/PageGlows'
import { StatusBadge } from '@/components/common/StatusBadge'

// TODO: replace with real data from useTodayAttendance / useMonthAttendance.
const SAMPLE_RECENT = [
  { date: 'Mon, May 5', checkIn: '09:12', checkOut: '18:24', hours: '9h 12m', status: 'present' },
  { date: 'Tue, May 6', checkIn: '09:34', checkOut: '18:30', hours: '8h 56m', status: 'late' },
  { date: 'Wed, May 7', checkIn: '09:01', checkOut: '18:10', hours: '9h 09m', status: 'present' },
  { date: 'Thu, May 8', checkIn: '—', checkOut: '—', hours: '—', status: 'on_leave' },
  { date: 'Fri, May 2', checkIn: '08:55', checkOut: '17:50', hours: '8h 55m', status: 'present' },
] as const

export default function AttendancePage() {
  const [isClockedIn, setIsClockedIn] = useState(false)
  const [clockInAt, setClockInAt] = useState<string | null>(null)

  const toggleClock = () => {
    if (isClockedIn) {
      setIsClockedIn(false)
      setClockInAt(null)
    } else {
      setIsClockedIn(true)
      setClockInAt(
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      )
    }
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
          <h1 className="text-3xl font-bold text-white font-gilroy">Attendance</h1>
          <p className="text-brand-muted mt-1">
            Track your work day and review recent activity
          </p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass rounded-xl p-6 lg:col-span-2 flex items-center justify-between gap-6 flex-wrap"
          >
            <div>
              <div className="text-xs uppercase tracking-wider text-white/40 font-gilroy">
                {isClockedIn ? 'Clocked in' : 'Ready to start'}
              </div>
              <div className="text-3xl font-bold text-white font-gilroy mt-1">
                {clockInAt ?? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="text-sm text-brand-muted mt-1">
                {isClockedIn
                  ? 'Have a productive day — clock out when you wrap up.'
                  : 'Clock in to start tracking your hours for today.'}
              </div>
            </div>
            <Button
              size="xl"
              variant={isClockedIn ? 'destructive' : 'default'}
              onClick={toggleClock}
            >
              {isClockedIn ? (
                <>
                  <LogOut className="w-5 h-5" />
                  Clock out
                </>
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  Clock in
                </>
              )}
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="glass rounded-xl p-6"
          >
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-4 h-4 text-brand-blue" />
              <span className="text-sm font-semibold text-white font-gilroy">
                Today
              </span>
            </div>
            <SummaryRow label="Status" value={isClockedIn ? 'Working' : 'Not started'} />
            <SummaryRow label="Check-in" value={clockInAt ?? '—'} />
            <SummaryRow label="Hours" value={isClockedIn ? 'Live' : '0h 0m'} />
            <SummaryRow label="Break" value="0m" />
          </motion.div>
        </div>

        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h2 className="text-sm font-semibold text-white font-gilroy">
              Recent days
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06] text-left">
                  {['Date', 'Check-in', 'Check-out', 'Hours', 'Status'].map((h) => (
                    <th
                      key={h}
                      className="px-6 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SAMPLE_RECENT.map((row) => (
                  <tr
                    key={row.date}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-6 py-4 text-sm text-white font-gilroy">{row.date}</td>
                    <td className="px-6 py-4 text-sm text-white/70 font-gilroy">{row.checkIn}</td>
                    <td className="px-6 py-4 text-sm text-white/70 font-gilroy">{row.checkOut}</td>
                    <td className="px-6 py-4 text-sm text-white/70 font-gilroy">{row.hours}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-b-0">
      <span className="text-xs text-white/50 font-gilroy">{label}</span>
      <span className="text-sm text-white font-gilroy font-medium">{value}</span>
    </div>
  )
}
