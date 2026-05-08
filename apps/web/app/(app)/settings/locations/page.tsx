'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { MapPin, Plus, Trash2 } from 'lucide-react'
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

// TODO: wire to useLocations / useCreateLocation
const SEED = [
  { id: 'l_1', name: 'Bengaluru HQ', address: 'Indiranagar, Bengaluru' },
  { id: 'l_2', name: 'Mumbai Office', address: 'Andheri East, Mumbai' },
  { id: 'l_3', name: 'Remote', address: 'Distributed' },
]

export default function LocationsSettingsPage() {
  const [items, setItems] = useState(SEED)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setItems((curr) => [
      ...curr,
      { id: `l_${Date.now()}`, name: name.trim(), address: address.trim() },
    ])
    setName('')
    setAddress('')
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
            <h1 className="text-3xl font-bold text-white font-gilroy">Locations</h1>
            <p className="text-brand-muted mt-1">
              Offices and work sites your team operates from
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="w-4 h-4" />
            Add location
          </Button>
        </motion.div>

        <div className="glass rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="No locations yet"
              description="Add your first office to assign employees to it."
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
                      <MapPin className="w-4 h-4 text-brand-blue" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white font-gilroy">
                        {item.name}
                      </div>
                      <div className="text-xs text-white/50 font-gilroy">
                        {item.address || '—'}
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
            <DialogTitle>Add location</DialogTitle>
            <DialogDescription>
              Give your office a friendly name and address.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="loc-name">Name</Label>
              <Input
                id="loc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bengaluru HQ"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc-address">Address</Label>
              <Input
                id="loc-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, city, country"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Add location</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
