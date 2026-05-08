'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageGlows } from '@/components/layout/PageGlows'
import { useAuthStore } from '@/lib/stores/auth.store'

export default function OrganizationSettingsPage() {
  const { currentTenant } = useAuthStore()
  const [name, setName] = useState(currentTenant?.name ?? '')

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    // TODO: wire to useUpdateTenant
  }

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-3xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold text-white font-gilroy">
            Organization
          </h1>
          <p className="text-brand-muted mt-1">
            Manage your workspace name, branding and identity
          </p>
        </motion.div>

        <form onSubmit={handleSave} className="glass rounded-xl p-6 space-y-6">
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme, Inc."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-slug">Workspace slug</Label>
            <Input
              id="org-slug"
              value={currentTenant?.slug ?? ''}
              readOnly
              className="opacity-70 cursor-not-allowed"
            />
            <p className="text-xs text-white/40 font-gilroy">
              The slug can’t be changed once your workspace is created.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Logo</Label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-lg bg-white/5 border border-dashed border-white/15 flex items-center justify-center">
                <ImageIcon className="w-5 h-5 text-white/30" />
              </div>
              <Button type="button" variant="outline" size="sm" disabled>
                Upload logo
              </Button>
            </div>
            <p className="text-xs text-white/40 font-gilroy">
              Logo upload coming soon — square PNG or SVG up to 2 MB.
            </p>
          </div>

          <div className="flex justify-end">
            <Button type="submit">Save changes</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
