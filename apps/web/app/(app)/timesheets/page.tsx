'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageGlows } from '@/components/layout/PageGlows'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
type Day = (typeof DAYS)[number]
type ProjectRow = { id: string; name: string; hours: Record<Day, string> }

// TODO: replace with real timesheet data once useWeekTimesheet ships.
const SEED: ProjectRow[] = [
  { id: 'p_1', name: 'Internal HR product', hours: { Mon: '4', Tue: '3', Wed: '5', Thu: '4', Fri: '6', Sat: '', Sun: '' } },
  { id: 'p_2', name: 'Client onboarding', hours: { Mon: '2', Tue: '4', Wed: '2', Thu: '2', Fri: '1', Sat: '', Sun: '' } },
  { id: 'p_3', name: 'Documentation', hours: { Mon: '1', Tue: '1', Wed: '1', Thu: '2', Fri: '1', Sat: '', Sun: '' } },
]

export default function TimesheetsPage() {
  const [rows, setRows] = useState<ProjectRow[]>(SEED)

  const totals = useMemo(() => {
    const dayTotals: Record<Day, number> = {
      Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0,
    }
    let grand = 0
    for (const row of rows) {
      for (const day of DAYS) {
        const v = parseFloat(row.hours[day]) || 0
        dayTotals[day] += v
        grand += v
      }
    }
    return { dayTotals, grand }
  }, [rows])

  const updateCell = (rowId: string, day: Day, value: string) => {
    setRows((curr) =>
      curr.map((r) =>
        r.id === rowId ? { ...r, hours: { ...r.hours, [day]: value } } : r
      )
    )
  }

  const rowTotal = (row: ProjectRow) =>
    DAYS.reduce((acc, d) => acc + (parseFloat(row.hours[d]) || 0), 0)

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-white font-gilroy">Timesheets</h1>
          <p className="text-brand-muted mt-1">
            Log hours by project for this week
          </p>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06] text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider min-w-[180px]">
                    Project
                  </th>
                  {DAYS.map((d) => (
                    <th
                      key={d}
                      className="px-3 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider text-center"
                    >
                      {d}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-xs font-semibold text-white/40 font-gilroy uppercase tracking-wider text-right">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-4 py-3 text-sm text-white font-gilroy">
                      {row.name}
                    </td>
                    {DAYS.map((d) => (
                      <td key={d} className="px-2 py-2">
                        <Input
                          type="number"
                          min={0}
                          step={0.25}
                          value={row.hours[d]}
                          onChange={(e) => updateCell(row.id, d, e.target.value)}
                          className="h-9 text-center px-1"
                        />
                      </td>
                    ))}
                    <td className="px-4 py-3 text-sm text-white font-gilroy font-semibold text-right">
                      {rowTotal(row).toFixed(2)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-white/[0.03]">
                  <td className="px-4 py-3 text-sm font-semibold text-white/70 font-gilroy uppercase tracking-wider">
                    Totals
                  </td>
                  {DAYS.map((d) => (
                    <td
                      key={d}
                      className="px-3 py-3 text-sm text-white font-gilroy font-semibold text-center"
                    >
                      {totals.dayTotals[d].toFixed(2)}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-sm text-brand-blue font-gilroy font-bold text-right">
                    {totals.grand.toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <Button
            onClick={() => {
              // TODO: wire to useSubmitTimesheet
            }}
          >
            <Send className="w-4 h-4" />
            Submit week
          </Button>
        </div>
      </div>
    </div>
  )
}
