'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Bell, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

// TODO: wire to useNotificationRules
type Channel = 'email' | 'slack' | 'in_app'
type Rule = { id: string; name: string; channel: Channel; enabled: boolean }

const SEED: Rule[] = [
  { id: 'n_1', name: 'Leave request approved', channel: 'email', enabled: true },
  { id: 'n_2', name: 'Late check-in alert', channel: 'slack', enabled: true },
  { id: 'n_3', name: 'Weekly attendance summary', channel: 'email', enabled: false },
]

export default function NotificationsSettingsPage() {
  const [items, setItems] = useState<Rule[]>(SEED)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<Channel>('email')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setItems((curr) => [
      ...curr,
      {
        id: `n_${Date.now()}`,
        name: name.trim(),
        channel,
        enabled: true,
      },
    ])
    setName('')
    setChannel('email')
    setOpen(false)
  }

  const toggle = (id: string) => {
    setItems((curr) =>
      curr.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    )
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
              Notifications
            </h1>
            <p className="text-brand-muted mt-1">
              Control which events trigger notifications and where they’re sent
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4" />
            Add rule
          </Button>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No notification rules"
              description="Add a rule to start sending automated notifications."
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
                      <Bell className="w-4 h-4 text-brand-blue" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white font-gilroy">
                        {item.name}
                      </div>
                      <div className="text-xs text-white/50 font-gilroy capitalize">
                        {item.channel.replace('_', ' ')}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={item.enabled}
                      onCheckedChange={() => toggle(item.id)}
                    />
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add notification rule</DialogTitle>
            <DialogDescription>
              Choose an event and the channel it should be delivered to.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rule-name">Rule name</Label>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New leave request"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-channel">Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
                <SelectTrigger id="rule-channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="in_app">In-app</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Add rule</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
