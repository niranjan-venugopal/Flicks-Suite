'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Calendar, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'

// TODO: wire to useLeavePolicies
const SEED = [
  { id: 'lp_1', name: 'Casual', daysPerYear: 12, accrual: 'Monthly' },
  { id: 'lp_2', name: 'Sick', daysPerYear: 8, accrual: 'Yearly' },
  { id: 'lp_3', name: 'Earned', daysPerYear: 18, accrual: 'Monthly' },
]

export default function LeavePoliciesSettingsPage() {
  const [items, setItems] = useState(SEED)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [days, setDays] = useState('12')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setItems((curr) => [
      ...curr,
      {
        id: `lp_${Date.now()}`,
        name: name.trim(),
        daysPerYear: parseInt(days, 10) || 0,
        accrual: 'Monthly',
      },
    ])
    setName('')
    setDays('12')
    setOpen(false)
  }

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 mb-8 flex-wrap"
        >
          <div>
            <h1 className="text-3xl font-bold text-white font-gilroy">
              Leave policies
            </h1>
            <p className="text-brand-muted mt-1">
              Configure leave types and accrual rules
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4" />
            Add policy
          </Button>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="No policies yet"
              description="Define your first leave type so employees can apply for time off."
            />
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-6 py-4 gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-brand-blue/10 flex items-center justify-center shrink-0">
                      <Calendar className="w-4 h-4 text-brand-blue" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white font-gilroy">
                        {item.name}
                      </div>
                      <div className="text-xs text-white/50 font-gilroy">
                        {item.daysPerYear} days / year · {item.accrual}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      setItems((curr) => curr.filter((i) => i.id !== item.id))
                    }
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add leave policy</DialogTitle>
            <DialogDescription>
              Define a leave type and how many days are granted per year.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lp-name">Policy name</Label>
              <Input
                id="lp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Casual leave"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lp-days">Days per year</Label>
              <Input
                id="lp-days"
                type="number"
                min={0}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Add policy</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
