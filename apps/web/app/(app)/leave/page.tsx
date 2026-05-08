'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Calendar, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PageGlows } from '@/components/layout/PageGlows'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusBadge } from '@/components/common/StatusBadge'

// TODO: replace with real data from useMyLeaves / useTeamLeaves once wired.
type MyLeave = { id: string; type: string; from: string; to: string; days: number; status: string }
type TeamLeave = { id: string; name: string; type: string; from: string; to: string; status: string }

const MY_LEAVES: MyLeave[] = [
  { id: 'l_1', type: 'Casual', from: 'May 12', to: 'May 13', days: 2, status: 'approved' },
  { id: 'l_2', type: 'Sick', from: 'Apr 02', to: 'Apr 02', days: 1, status: 'approved' },
]

const TEAM_LEAVES: TeamLeave[] = [
  { id: 'tl_1', name: 'Aanya Kapoor', type: 'Casual', from: 'May 12', to: 'May 13', status: 'pending' },
  { id: 'tl_2', name: 'Rohan Mehta', type: 'Sick', from: 'May 9', to: 'May 9', status: 'approved' },
]

export default function LeavePage() {
  const [applyOpen, setApplyOpen] = useState(false)

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 mb-8 flex-wrap"
        >
          <div>
            <h1 className="text-3xl font-bold text-white font-gilroy">Leave</h1>
            <p className="text-brand-muted mt-1">
              Plan time off and review approvals across your team
            </p>
          </div>
          <Button onClick={() => setApplyOpen(true)} className="shrink-0">
            <Plus className="w-4 h-4" />
            Apply for leave
          </Button>
        </motion.div>

        <Tabs defaultValue="my">
          <TabsList>
            <TabsTrigger value="my">My leave</TabsTrigger>
            <TabsTrigger value="team">Team leave</TabsTrigger>
            <TabsTrigger value="apply">Apply</TabsTrigger>
          </TabsList>

          <TabsContent value="my">
            <div className="glass rounded-xl overflow-hidden">
              {MY_LEAVES.length === 0 ? (
                <EmptyState
                  icon={Calendar}
                  title="No leave taken yet"
                  description="Apply for time off and your requests will land here."
                />
              ) : (
                <LeaveTable
                  rows={MY_LEAVES.map((l) => ({
                    cells: [l.type, l.from, l.to, `${l.days} day${l.days > 1 ? 's' : ''}`],
                    status: l.status,
                    key: l.id,
                  }))}
                  headers={['Type', 'From', 'To', 'Days', 'Status']}
                />
              )}
            </div>
          </TabsContent>

          <TabsContent value="team">
            <div className="glass rounded-xl overflow-hidden">
              {TEAM_LEAVES.length === 0 ? (
                <EmptyState
                  icon={Calendar}
                  title="No team requests"
                  description="When teammates apply, their requests will show up here for approval."
                />
              ) : (
                <LeaveTable
                  rows={TEAM_LEAVES.map((l) => ({
                    cells: [l.name, l.type, l.from, l.to],
                    status: l.status,
                    key: l.id,
                  }))}
                  headers={['Name', 'Type', 'From', 'To', 'Status']}
                />
              )}
            </div>
          </TabsContent>

          <TabsContent value="apply">
            <div className="glass rounded-xl p-8 max-w-xl">
              <h2 className="text-lg font-bold text-white font-gilroy mb-1">
                Apply for leave
              </h2>
              <p className="text-sm text-brand-muted mb-6">
                Pick your dates and let your manager know why you’ll be away.
              </p>
              <Button onClick={() => setApplyOpen(true)}>
                <Plus className="w-4 h-4" />
                Open form
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />
    </div>
  )
}

function LeaveTable({
  rows,
  headers,
}: {
  headers: string[]
  rows: Array<{ key: string; cells: string[]; status: string }>
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/[0.06] text-left">
            {headers.map((h) => (
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
          {rows.map((row) => (
            <tr
              key={row.key}
              className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
            >
              {row.cells.map((c, i) => (
                <td key={i} className="px-6 py-4 text-sm text-white/80 font-gilroy">
                  {c}
                </td>
              ))}
              <td className="px-6 py-4">
                <StatusBadge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ApplyLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [type, setType] = useState<string>('casual')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // TODO: wire to useApplyLeave mutation
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply for leave</DialogTitle>
          <DialogDescription>
            Pick your leave type and dates. Your manager will be notified.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="leave-type">Leave type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="leave-type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="casual">Casual</SelectItem>
                <SelectItem value="sick">Sick</SelectItem>
                <SelectItem value="earned">Earned</SelectItem>
                <SelectItem value="unpaid">Unpaid</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="leave-from">From</Label>
              <Input
                id="leave-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="leave-to">To</Label>
              <Input
                id="leave-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea
              id="leave-reason"
              placeholder="Share a quick note for your manager"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Submit request</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
