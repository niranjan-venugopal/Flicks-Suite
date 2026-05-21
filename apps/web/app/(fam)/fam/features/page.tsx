'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useFamFeatureFlags,
  useUpsertFeatureFlag,
  type FamFeatureFlag,
} from '@/lib/api/queries/use-fam'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { timeAgo } from '@/lib/utils'

export default function FamFeatureFlagsPage() {
  const flags = useFamFeatureFlags()
  const upsert = useUpsertFeatureFlag()
  const { toast } = useToast()

  const [editing, setEditing] = useState<FamFeatureFlag | 'new' | null>(null)
  const [flagKey, setFlagKey] = useState('')
  const [description, setDescription] = useState('')
  const [globally, setGlobally] = useState(false)
  const [rollout, setRollout] = useState(0)

  const open = (f: FamFeatureFlag | 'new') => {
    if (f === 'new') {
      setFlagKey('')
      setDescription('')
      setGlobally(false)
      setRollout(0)
    } else {
      setFlagKey(f.flagKey)
      setDescription(f.description ?? '')
      setGlobally(f.isEnabledGlobally)
      setRollout(f.rolloutPercentage)
    }
    setEditing(f)
  }

  const submit = async () => {
    if (!flagKey.trim()) {
      toast({ title: 'Flag key is required', variant: 'destructive' })
      return
    }
    try {
      await upsert.mutateAsync({
        flagKey: flagKey.trim(),
        description: description.trim() || undefined,
        isEnabledGlobally: globally,
        rolloutPercentage: rollout,
      })
      toast({ title: 'Saved', description: flagKey.trim() })
      setEditing(null)
    } catch (e) {
      toast({ title: 'Could not save', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  const rows = flags.data?.data ?? []

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Feature flags"
          sub={`${rows.length} flag${rows.length === 1 ? '' : 's'} configured.`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Pill tone="purple" dot>Sprint 3 · C5</Pill>
              <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => open('new')}>
                New flag
              </Btn>
            </div>
          }
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {flags.isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
              <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12.5 }}>
              No flags yet. Create one to start gating new features.
            </div>
          ) : (
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Flag</th>
                  <th>Global</th>
                  <th>Rollout %</th>
                  <th>Tenants</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 800 }}>{f.flagKey}</div>
                      {f.description && (
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                          {f.description}
                        </div>
                      )}
                    </td>
                    <td>
                      <Pill tone={f.isEnabledGlobally ? 'green' : ''} dot>
                        {f.isEnabledGlobally ? 'on' : 'off'}
                      </Pill>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{f.rolloutPercentage}%</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{f.enabledTenantIds.length}</td>
                    <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>{timeAgo(f.updatedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Btn kind="ghost" size="sm" icon={<Icon.edit size={12} />} onClick={() => open(f)}>
                        Edit
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'New feature flag' : `Edit ${flagKey}`}</DialogTitle>
          </DialogHeader>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Flag key</label>
          <input
            className="input"
            value={flagKey}
            onChange={(e) => setFlagKey(e.target.value)}
            disabled={editing !== 'new'}
            placeholder="beta.timesheets_v2"
            style={{ width: '100%', padding: 10, fontFamily: 'var(--font-mono)', fontSize: 12.5, marginBottom: 12 }}
          />
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Description</label>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short one-liner for what this flag gates."
            style={{ width: '100%', padding: 10, fontSize: 12.5, marginBottom: 12 }}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              fontWeight: 700,
              marginBottom: 12,
              cursor: 'pointer',
            }}
          >
            <input type="checkbox" checked={globally} onChange={(e) => setGlobally(e.target.checked)} />
            Enabled globally
          </label>
          <label className="label" style={{ display: 'block', marginBottom: 6 }}>Rollout %</label>
          <input
            className="input"
            type="number"
            min={0}
            max={100}
            value={rollout}
            onChange={(e) => setRollout(Number(e.target.value))}
            style={{ width: 120, padding: 10, fontSize: 13 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Btn kind="ghost" onClick={() => setEditing(null)} disabled={upsert.isPending}>Cancel</Btn>
            <Btn kind="primary" onClick={submit} disabled={upsert.isPending}>
              {upsert.isPending ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
