'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

// TODO: wire to useMembers / useInviteMember
const SEED = [
  { id: 'm_1', name: 'Aanya Kapoor', email: 'aanya@example.com', role: 'HR_ADMIN' },
  { id: 'm_2', name: 'Rohan Mehta', email: 'rohan@example.com', role: 'MANAGER' },
  { id: 'm_3', name: 'Priya Sharma', email: 'priya@example.com', role: 'EMPLOYEE' },
]

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  HR_ADMIN: 'HR admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
}

export default function MembersSettingsPage() {
  const [items, setItems] = useState(SEED)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('EMPLOYEE')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setItems((curr) => [
      ...curr,
      {
        id: `m_${Date.now()}`,
        name: email.split('@')[0] ?? email,
        email: email.trim(),
        role,
      },
    ])
    setEmail('')
    setRole('EMPLOYEE')
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
            <h1 className="text-3xl font-bold text-white font-gilroy">Members</h1>
            <p className="text-brand-muted mt-1">
              Manage workspace access and admin roles
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4" />
            Invite member
          </Button>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members yet"
              description="Invite a teammate to give them access to your workspace."
            />
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-6 py-4 gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-brand-blue/15 border border-brand-blue/20 flex items-center justify-center shrink-0">
                      <span className="text-sm font-bold text-brand-blue font-gilroy">
                        {item.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white font-gilroy">
                        {item.name}
                      </div>
                      <div className="text-xs text-white/50 font-gilroy">
                        {item.email} · {ROLE_LABEL[item.role] ?? item.role}
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
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>
              They’ll receive an email with a magic link to join your workspace.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="member-email">Email</Label>
              <Input
                id="member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="member-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HR_ADMIN">HR admin</SelectItem>
                  <SelectItem value="MANAGER">Manager</SelectItem>
                  <SelectItem value="EMPLOYEE">Employee</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Send invite</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
