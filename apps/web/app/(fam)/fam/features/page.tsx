'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useFamFeatureFlags,
  useUpsertFeatureFlag,
  type FamFeatureFlag,
} from '@/lib/api/queries/use-fam'
import { useToast } from '@/components/ui/use-toast'
import { timeAgo } from '@/lib/utils'

function rolloutLabel(f: FamFeatureFlag): { label: string; tone: 'green' | 'blue' | 'purple' | 'yellow' | '' } {
  if (!f.isEnabledGlobally && f.rolloutPercentage === 0 && f.enabledTenantIds.length === 0) {
    return { label: 'Off', tone: '' }
  }
  if (f.isEnabledGlobally && f.rolloutPercentage >= 100) return { label: 'GA', tone: 'green' }
  if (f.rolloutPercentage > 0 && f.rolloutPercentage < 100) return { label: 'Beta', tone: 'blue' }
  if (f.enabledTenantIds.length > 0 && !f.isEnabledGlobally) return { label: 'Allowlist', tone: 'purple' }
  return { label: 'Beta', tone: 'blue' }
}

export default function FamFeatureFlagsPage() {
  const flags = useFamFeatureFlags()
  const upsert = useUpsertFeatureFlag()
  const { toast } = useToast()

  const rows = flags.data?.data ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    if (rows.length > 0 && (!selectedId || !rows.find((f) => f.id === selectedId))) {
      setSelectedId(rows[0].id)
    }
  }, [rows, selectedId])
  const selected = rows.find((f) => f.id === selectedId) ?? null

  // Local draft state — populated when a flag is selected.
  const [draftEnabled, setDraftEnabled] = useState(false)
  const [draftPct, setDraftPct] = useState(0)
  const [draftDescription, setDraftDescription] = useState('')
  useEffect(() => {
    if (!selected) return
    setDraftEnabled(selected.isEnabledGlobally)
    setDraftPct(selected.rolloutPercentage)
    setDraftDescription(selected.description ?? '')
  }, [selected])

  const dirty =
    selected &&
    (draftEnabled !== selected.isEnabledGlobally ||
      draftPct !== selected.rolloutPercentage ||
      draftDescription !== (selected.description ?? ''))

  const handleSave = async () => {
    if (!selected) return
    try {
      await upsert.mutateAsync({
        flagKey: selected.flagKey,
        description: draftDescription || undefined,
        isEnabledGlobally: draftEnabled,
        enabledTenantIds: selected.enabledTenantIds,
        rolloutPercentage: draftPct,
      })
      toast({ title: 'Saved', description: selected.flagKey })
    } catch (e) {
      toast({
        title: 'Could not save',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Feature flags"
          sub="Per-tenant rollout · changes propagate to clients on next /me refresh"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.shield size={13} />}>
                Audit changes
              </Btn>
              <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />}>
                New flag
              </Btn>
            </div>
          }
        />

        {flags.isLoading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
          </div>
        ) : rows.length === 0 ? (
          <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)', fontSize: 12.5 }}>
            No flags yet. Create one to start gating new features.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 14 }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table className="tbl" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Flag</th>
                    <th>Rollout</th>
                    <th style={{ textAlign: 'right' }}>%</th>
                    <th style={{ textAlign: 'right' }}>Tenants</th>
                    <th>Last change</th>
                    <th style={{ textAlign: 'right' }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => {
                    const r = rolloutLabel(f)
                    const isActive = f.id === selectedId
                    return (
                      <tr
                        key={f.id}
                        onClick={() => setSelectedId(f.id)}
                        style={{
                          background: isActive ? 'var(--surf-2)' : 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <td>
                          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--blue)', fontSize: 12 }}>
                            {f.flagKey}
                          </div>
                          {f.description && (
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                              {f.description}
                            </div>
                          )}
                        </td>
                        <td>
                          <Pill tone={r.tone} dot>{r.label}</Pill>
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                          {f.rolloutPercentage}%
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
                          {f.enabledTenantIds.length}
                        </td>
                        <td style={{ fontSize: 11.5, color: 'var(--text-mute)' }}>
                          {timeAgo(f.updatedAt)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Toggle on={f.isEnabledGlobally} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Detail panel */}
            {selected ? (
              <div className="card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: 'var(--surf-2)',
                      color: 'var(--blue)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon.zap size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        fontWeight: 800,
                        color: 'var(--blue)',
                        wordBreak: 'break-all',
                      }}
                    >
                      {selected.flagKey}
                    </div>
                    <input
                      className="input"
                      value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                      placeholder="Short one-liner for what this flag gates."
                      style={{
                        marginTop: 4,
                        fontSize: 11.5,
                        width: '100%',
                        padding: '6px 8px',
                        background: 'transparent',
                        border: '1px dashed var(--bord)',
                      }}
                    />
                  </div>
                </div>

                {/* Globally enabled */}
                <div
                  style={{
                    padding: '12px 14px',
                    background: 'var(--surf-1)',
                    borderRadius: 8,
                    border: '1px solid var(--bord)',
                    marginBottom: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>Globally enabled</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                      Kill-switch · turn off everywhere
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraftEnabled(!draftEnabled)}
                    style={{
                      display: 'inline-block',
                      width: 38,
                      height: 20,
                      borderRadius: 99,
                      background: draftEnabled ? 'var(--green)' : 'var(--surf-3, #2A2A40)',
                      position: 'relative',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: draftEnabled ? 20 : 2,
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        background: '#fff',
                        transition: 'left .15s',
                      }}
                    />
                  </button>
                </div>

                {/* Rollout slider */}
                <div style={{ marginBottom: 14 }}>
                  <label
                    className="label"
                    style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}
                  >
                    <span>Percentage rollout</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--blue)' }}>
                      {draftPct}%
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draftPct}
                    onChange={(e) => setDraftPct(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 6 }}>
                    Hash-based deterministic rollout — tenants either get the flag or don't, no flicker between visits.
                  </div>
                </div>

                {/* Allowlist */}
                <div style={{ marginBottom: 14 }}>
                  <label className="label" style={{ marginBottom: 6, display: 'block' }}>
                    Tenant allowlist · always-on
                  </label>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      padding: '8px 10px',
                      background: 'var(--surf-1)',
                      border: '1px solid var(--bord)',
                      borderRadius: 8,
                      minHeight: 42,
                      alignItems: 'center',
                    }}
                  >
                    {selected.enabledTenantIds.length === 0 ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
                        Empty — no tenants pinned to this flag.
                      </span>
                    ) : (
                      selected.enabledTenantIds.map((id) => (
                        <span
                          key={id}
                          style={{
                            display: 'inline-flex',
                            gap: 5,
                            alignItems: 'center',
                            padding: '3px 8px',
                            background: 'var(--surf-2)',
                            border: '1px solid var(--bord-2)',
                            borderRadius: 99,
                            fontSize: 11,
                            fontWeight: 700,
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {id.slice(0, 8)}
                          <Icon.x size={10} style={{ opacity: 0.6 }} />
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <div
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(62,123,250,.08)',
                    border: '1px solid rgba(62,123,250,.28)',
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1.55,
                    color: 'var(--text-2)',
                  }}
                >
                  <Icon.shield size={12} style={{ display: 'inline', marginRight: 5, color: 'var(--blue)' }} />
                  Last changed <strong style={{ color: '#fff' }}>{timeAgo(selected.updatedAt)}</strong>.
                  All flag mutations are logged in{' '}
                  <code style={{ fontFamily: 'var(--font-mono)' }}>audit_log_platform</code>.
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <Btn
                    kind="ghost"
                    size="sm"
                    onClick={() => {
                      setDraftEnabled(selected.isEnabledGlobally)
                      setDraftPct(selected.rolloutPercentage)
                      setDraftDescription(selected.description ?? '')
                    }}
                    disabled={!dirty}
                  >
                    Reset
                  </Btn>
                  <div style={{ flex: 1 }} />
                  <Btn
                    kind="primary"
                    size="sm"
                    onClick={handleSave}
                    disabled={!dirty || upsert.isPending}
                  >
                    {upsert.isPending ? 'Saving…' : 'Save'}
                  </Btn>
                </div>
              </div>
            ) : (
              <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-mute)' }}>
                Select a flag to edit.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 34,
        height: 18,
        borderRadius: 99,
        background: on ? 'var(--green)' : 'var(--surf-3, #2A2A40)',
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 18 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 4px rgba(0,0,0,.3)',
        }}
      />
    </span>
  )
}
