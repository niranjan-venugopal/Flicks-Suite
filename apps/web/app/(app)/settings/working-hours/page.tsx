'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Clock, Plus, Trash2 } from 'lucide-react'
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

// TODO: wire to useWorkingHours
const SEED = [
  { id: 'wh_1', name: 'Standard', start: '09:30', end: '18:30', days: 'Mon–Fri' },
  { id: 'wh_2', name: 'Night shift', start: '21:00', end: '06:00', days: 'Mon–Sat' },
]

export default function WorkingHoursSettingsPage() {
  const [items, setItems] = useState(SEED)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('18:00')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setItems((curr) => [
      ...curr,
      { id: `wh_${Date.now()}`, name: name.trim(), start, end, days: 'Mon–Fri' },
    ])
    setName('')
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
              Working hours
            </h1>
            <p className="text-brand-muted mt-1">
              Define shift patterns for different teams
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4" />
            Add shift
          </Button>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No shifts defined"
              description="Add a shift pattern so attendance can be tracked accurately."
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
                      <Clock className="w-4 h-4 text-brand-blue" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white font-gilroy">
                        {item.name}
                      </div>
                      <div className="text-xs text-white/50 font-gilroy">
                        {item.start} – {item.end} · {item.days}
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
            <DialogTitle>Add shift</DialogTitle>
            <DialogDescription>
              Define the regular working window for a group of employees.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="wh-name">Shift name</Label>
              <Input
                id="wh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Standard"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="wh-start">Start</Label>
                <Input
                  id="wh-start"
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wh-end">End</Label>
                <Input
                  id="wh-end"
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  required
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Add shift</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
