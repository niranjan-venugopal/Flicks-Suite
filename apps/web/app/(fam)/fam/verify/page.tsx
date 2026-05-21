'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Avatar, Btn, Icon, Pill, SectionHead } from '@/components/proto'
import {
  useFamVerificationQueue,
  useVerifyTenant,
  type FamVerificationTenant,
} from '@/lib/api/queries/use-fam'
import { useToast } from '@/components/ui/use-toast'
import { timeAgo, formatDate } from '@/lib/utils'

// GSTIN format check — 15 alphanumeric chars, state code 01-37.
function gstinFormatPass(gstin: string | null): boolean {
  if (!gstin) return false
  return /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Z][0-9A-Z]$/.test(gstin)
}
function panFormatPass(pan: string | null): boolean {
  if (!pan) return false
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)
}
function stateCodeOf(gstin: string | null): string | null {
  if (!gstin || gstin.length < 2) return null
  return gstin.slice(0, 2)
}

export default function FamVerifyPage() {
  const queue = useFamVerificationQueue()
  const verify = useVerifyTenant()
  const { toast } = useToast()

  const rows = queue.data?.data ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [decisionNotes, setDecisionNotes] = useState('')

  // Auto-select the first row when data loads.
  useEffect(() => {
    if (rows.length > 0 && (!selectedId || !rows.find((r) => r.id === selectedId))) {
      setSelectedId(rows[0].id)
    }
  }, [rows, selectedId])

  const selected = rows.find((r) => r.id === selectedId) ?? null

  const handleApprove = async () => {
    if (!selected) return
    try {
      await verify.mutateAsync(selected.id)
      toast({
        title: 'Verified',
        description: `${selected.name} approved & verified.`,
      })
      setDecisionNotes('')
      setSelectedId(null)
    } catch (e) {
      toast({
        title: 'Could not verify',
        description: e instanceof Error ? e.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Verification queue"
          sub={`${rows.length} tenant${rows.length === 1 ? '' : 's'} pending review · GSTIN + PAN checks`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="secondary" size="sm" icon={<Icon.filter size={13} />}>
                Filter
              </Btn>
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />}>
                Export queue
              </Btn>
            </div>
          }
        />

        {queue.isLoading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-mute)' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} />
          </div>
        ) : rows.length === 0 ? (
          <div className="card" style={{ padding: 60, textAlign: 'center' }}>
            <Icon.success size={28} style={{ opacity: 0.55 }} />
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 10 }}>All caught up.</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 4 }}>
              No tenants pending verification.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 14 }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div
                style={{
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--bord)',
                  display: 'flex',
                  gap: 6,
                }}
              >
                <FilterChip active>All · {rows.length}</FilterChip>
                <FilterChip>High</FilterChip>
                <FilterChip>Med</FilterChip>
              </div>
              <div style={{ maxHeight: 640, overflow: 'auto' }}>
                {rows.map((q) => {
                  const isActive = q.id === selectedId
                  const priority = priorityFor(q)
                  return (
                    <button
                      key={q.id}
                      onClick={() => setSelectedId(q.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '14px 16px',
                        borderBottom: '1px solid var(--bord)',
                        background: isActive ? 'var(--surf-2)' : 'transparent',
                        border: 'none',
                        borderLeft: isActive ? '3px solid var(--blue)' : '3px solid transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <Avatar name={q.name} size="sm" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                            <span
                              style={{
                                fontSize: 12.5,
                                fontWeight: 800,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                flex: 1,
                              }}
                            >
                              {q.name}
                            </span>
                            <Pill tone={priorityTone(priority)}>{priority}</Pill>
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--text-mute)',
                              marginBottom: 4,
                              lineHeight: 1.4,
                            }}
                          >
                            {summarise(q)}
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              gap: 10,
                              fontSize: 10.5,
                              fontWeight: 700,
                              color: 'var(--text-faint)',
                            }}
                          >
                            <span>{timeAgo(q.createdAt)}</span>
                            <span>·</span>
                            <span>{q.industry ?? 'Unknown industry'}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Detail panel */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {selected ? (
                <>
                  <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <div
                      style={{
                        padding: '18px 22px',
                        borderBottom: '1px solid var(--bord)',
                        display: 'flex',
                        gap: 14,
                        alignItems: 'center',
                      }}
                    >
                      <Avatar name={selected.name} size="lg" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' }}>
                            {selected.name}
                          </span>
                          <Pill tone={priorityTone(priorityFor(selected))}>
                            {priorityFor(selected)} priority
                          </Pill>
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: 'var(--text-mute)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {selected.slug} · GSTIN {selected.gstin ?? '—'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Link href={`/fam/tenants/${selected.id}`} style={{ textDecoration: 'none' }}>
                          <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={13} />}>
                            Open tenant
                          </Btn>
                        </Link>
                      </div>
                    </div>

                    <div style={{ padding: '18px 22px' }}>
                      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 12 }}>
                        Verification checks
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <CheckRow
                          label="GSTIN format"
                          value={selected.gstin ?? '—'}
                          pass={gstinFormatPass(selected.gstin)}
                          detail={
                            selected.gstin
                              ? `15 chars · state code ${stateCodeOf(selected.gstin)}`
                              : 'No GSTIN submitted yet'
                          }
                        />
                        <CheckRow
                          label="PAN format"
                          value={selected.pan ?? '—'}
                          pass={panFormatPass(selected.pan)}
                          detail={
                            selected.pan
                              ? '5 letters · 4 digits · 1 check letter'
                              : 'PAN missing — request from tenant'
                          }
                        />
                        <CheckRow
                          label="Legal name"
                          value={selected.legalName ?? '—'}
                          pass={!!selected.legalName}
                          detail={
                            selected.legalName
                              ? 'Provided during onboarding'
                              : 'No legal name on file'
                          }
                        />
                        <CheckRow
                          label="Industry classification"
                          value={selected.industry ?? '—'}
                          pass={!!selected.industry}
                          detail={
                            selected.industry
                              ? `Workforce band: ${selected.sizeBand ?? 'unknown'}`
                              : 'Industry blank — manual review'
                          }
                        />
                        <CheckRow
                          label="Domain ownership"
                          value="DNS TXT not yet attempted"
                          pass={false}
                          detail="Pending workspace-domain check"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 12 }}>
                      Decision
                    </div>
                    <textarea
                      className="input"
                      rows={3}
                      placeholder="Decision notes · visible to all FAM agents in the audit trail"
                      value={decisionNotes}
                      onChange={(e) => setDecisionNotes(e.target.value)}
                      style={{ resize: 'vertical', marginBottom: 12, width: '100%', padding: 10 }}
                    />
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Btn kind="ghost" size="sm" icon={<Icon.send size={13} />} disabled>
                        Email tenant for clarification
                      </Btn>
                      <div style={{ flex: 1 }} />
                      <Btn kind="secondary" size="sm" disabled>
                        Snooze · 24h
                      </Btn>
                      <Btn kind="ghost" size="sm" style={{ color: 'var(--coral)' }} disabled>
                        Reject
                      </Btn>
                      <Btn
                        kind="primary"
                        size="sm"
                        icon={<Icon.shield size={13} />}
                        onClick={handleApprove}
                        disabled={verify.isPending}
                      >
                        {verify.isPending ? 'Verifying…' : 'Approve & verify'}
                      </Btn>
                    </div>
                  </div>
                </>
              ) : (
                <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)' }}>
                  Select a tenant from the queue.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function priorityFor(t: FamVerificationTenant): 'high' | 'medium' | 'low' {
  // Quick heuristic: older signups = higher priority. New signups (≤2d)
  // = low priority since they likely haven't completed onboarding yet.
  const ageDays = (Date.now() - new Date(t.createdAt).getTime()) / 86_400_000
  if (ageDays > 7) return 'high'
  if (ageDays > 2) return 'medium'
  return 'low'
}
function priorityTone(p: 'high' | 'medium' | 'low') {
  return p === 'high' ? 'coral' : p === 'medium' ? 'yellow' : ''
}
function summarise(t: FamVerificationTenant): string {
  if (!t.gstin) return 'GSTIN missing — request from tenant'
  if (!gstinFormatPass(t.gstin)) return 'GSTIN format invalid — manual review'
  if (!t.pan) return 'PAN missing — request from tenant'
  return 'GSTIN + PAN provided · ready for review'
}

function FilterChip({
  active,
  children,
}: {
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      style={{
        padding: '6px 10px',
        background: active ? 'var(--surf-2)' : 'transparent',
        border: `1px solid ${active ? 'var(--bord-2)' : 'var(--bord)'}`,
        borderRadius: 7,
        fontSize: 11,
        fontWeight: active ? 800 : 700,
        color: active ? '#fff' : 'var(--text-2)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function CheckRow({
  label,
  value,
  pass,
  detail,
}: {
  label: string
  value: string
  pass: boolean
  detail: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '12px 14px',
        background: 'var(--surf-1)',
        border: '1px solid var(--bord)',
        borderRadius: 9,
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: pass ? 'rgba(39,210,128,.15)' : 'rgba(248,120,107,.18)',
          color: pass ? 'var(--green)' : 'var(--coral)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {pass ? <Icon.check size={13} /> : <Icon.x size={13} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            marginBottom: 2,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 800 }}>{label}</span>
          <span
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              color: pass ? 'var(--green)' : 'var(--coral)',
            }}
          >
            {value}
          </span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
          {detail}
        </div>
      </div>
    </div>
  )
}

void formatDate
