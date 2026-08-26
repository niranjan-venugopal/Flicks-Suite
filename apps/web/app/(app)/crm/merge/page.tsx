'use client'

import { useState } from 'react'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import { EmptyState, OwnerAv } from '@/components/crm/kit'
import { useToast } from '@/components/ui/use-toast'
import {
  useMergeCandidates,
  useMergePreview,
  useMerge,
  useReps,
  useReassignPreview,
  useReassign,
  type MergeCandidate,
} from '@/lib/api/queries/use-crm'

// ─────────────────────────────────────────────────────────
// C15 — Dedupe finder + merge view, plus the §19.7
// offboarding reassignment card. Merging repoints every
// CRM reference to the survivor and leaves a tombstone.
// ─────────────────────────────────────────────────────────

export default function MergePage() {
  const [reviewing, setReviewing] = useState<MergeCandidate | null>(null)
  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 860, margin: '0 auto' }}>
      <SectionHead title="Data hygiene" sub="Find duplicates, merge them safely, and hand over work when someone leaves." />
      {reviewing
        ? <MergeView cand={reviewing} onClose={() => setReviewing(null)} />
        : <>
            <Finder onReview={setReviewing} />
            <ReassignCard />
          </>}
    </div>
  )
}

function Finder({ onReview }: { onReview: (c: MergeCandidate) => void }) {
  const { data, isLoading } = useMergeCandidates()
  const rows = data?.data ?? []
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
      <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center' }}>
        <div className="t-h3" style={{ flex: 1 }}>Dedupe finder — candidate pairs</div>
        <span className="t-caption">same email · same domain · similar name</span>
      </div>
      {isLoading ? (
        <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Icon.refresh size={18} className="animate-spin" style={{ color: 'var(--text-mute)' }} /></div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '10px 0' }}>
          <EmptyState icon={<Icon.copy size={22} />} line="No duplicate candidates right now — imports and manual adds are checked continuously." style={{ padding: '30px 24px' }} />
        </div>
      ) : (
        rows.map((c, i) => (
          <div key={`${c.a.id}:${c.b.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: i < rows.length - 1 ? '1px solid var(--bord)' : 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800 }}>
                {c.a.name ?? c.a.email} <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}>vs</span> {c.b.name ?? c.b.email}
              </div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-mute)' }}>{c.type} · {c.reason}</div>
            </div>
            <Pill tone={c.confidence > 90 ? 'green' : c.confidence > 80 ? 'blue' : 'yellow'}>{c.confidence}% match</Pill>
            <Btn kind="secondary" size="sm" onClick={() => onReview(c)}>Review</Btn>
          </div>
        ))
      )}
    </div>
  )
}

function MergeView({ cand, onClose }: { cand: MergeCandidate; onClose: () => void }) {
  const { toast } = useToast()
  const [winner, setWinner] = useState<'a' | 'b'>('a')
  const [done, setDone] = useState(false)
  const merge = useMerge()
  const w = cand[winner]
  const l = cand[winner === 'a' ? 'b' : 'a']
  const preview = useMergePreview(cand.type, w.id, l.id)

  const doMerge = async () => {
    try {
      await merge.mutateAsync({ type: cand.type, winner_id: w.id, loser_id: l.id })
      setDone(true)
    } catch (err) {
      toast({ title: 'Could not merge', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  if (done) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '36px 24px' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(39,210,128,.14)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          <Icon.check size={24} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Merged into {w.name ?? w.email}</div>
        <div className="t-mute" style={{ fontSize: 12, marginBottom: 14 }}>crm.{cand.type === 'company' ? 'company' : 'contact'}.merged published · tombstone left · audit-logged</div>
        <Btn kind="secondary" size="sm" onClick={onClose}>Back to finder</Btn>
      </div>
    )
  }

  const moving = preview.data?.data
  const movingLine = moving
    ? Object.entries(moving).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ') || 'nothing linked yet'
    : '…'

  return (
    <div className="card">
      <div className="t-h3" style={{ marginBottom: 4 }}>Merge {cand.type === 'company' ? 'companies' : 'contacts'}</div>
      <div className="t-mute" style={{ fontSize: 11.5, marginBottom: 16 }}>Pick the survivor — relations from both records move to it, the other gets a tombstone redirect</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        {(['a', 'b'] as const).map((side) => {
          const r = cand[side]
          const active = winner === side
          return (
            <button key={side} onClick={() => setWinner(side)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px', borderRadius: 12, background: active ? 'rgba(62,123,250,.1)' : 'var(--surf-1)', border: `1px solid ${active ? 'rgba(62,123,250,.45)' : 'var(--bord)'}`, cursor: 'pointer', textAlign: 'left' }}>
              <OwnerAv name={r.name ?? '?'} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#fff' }}>{r.name ?? '—'}</div>
                <div className="t-mute" style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>{r.email ?? r.domain ?? ''}</div>
              </div>
              {active && <Pill tone="blue">survivor ✓</Pill>}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 9, padding: '11px 14px', borderRadius: 10, background: 'var(--surf-1)', border: '1px solid var(--bord)', marginBottom: 14 }}>
        <Icon.info size={14} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)', lineHeight: 1.55 }}>
          <b style={{ color: '#fff' }}>Will move to the survivor:</b> {movingLine}. The other record is soft-deleted with a tombstone; everything is audit-logged.
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" icon={<Icon.swap size={14} />} disabled={merge.isPending} onClick={() => void doMerge()}>
          {merge.isPending ? 'Merging…' : 'Merge records'}
        </Btn>
      </div>
    </div>
  )
}

function ReassignCard() {
  const { toast } = useToast()
  const reps = useReps()
  const reassign = useReassign()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const preview = useReassignPreview(from || null)
  const p = preview.data?.data
  const total = p ? p.open_deals + p.open_activities + p.active_leads : 0

  const submit = async () => {
    try {
      const res = await reassign.mutateAsync({ from_user_id: from, to_user_id: to })
      toast({ title: 'Work handed over', description: `${res.data.deals} deals · ${res.data.activities} activities · ${res.data.leads} leads moved.` })
      setFrom(''); setTo('')
    } catch (err) {
      toast({ title: 'Could not reassign', description: err instanceof Error ? err.message : undefined, variant: 'destructive' })
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
        <Icon.userPlus size={15} style={{ color: 'var(--yellow)' }} />
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Offboarding — reassign work</span>
      </div>
      <div className="t-mute" style={{ fontSize: 11.5, marginBottom: 14 }}>
        Before deactivating a member, move their open deals, activities and leads to a teammate. Completed work keeps its history.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr auto', gap: 10, alignItems: 'end' }}>
        <div>
          <div className="label">From</div>
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '100%', height: 38 }}>
            <option value="">Pick a member…</option>
            {(reps.data?.data ?? []).map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 10 }}><Icon.arrow size={15} style={{ color: 'var(--text-faint)' }} /></div>
        <div>
          <div className="label">To</div>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%', height: 38 }}>
            <option value="">Pick a member…</option>
            {(reps.data?.data ?? []).filter((r) => r.user_id !== from).map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
          </select>
        </div>
        <Btn kind="primary" size="sm" icon={<Icon.check size={13} />} disabled={!from || !to || reassign.isPending || total === 0} onClick={() => void submit()}>
          {reassign.isPending ? 'Moving…' : 'Reassign'}
        </Btn>
      </div>
      {from && p && (
        <div className="t-caption" style={{ marginTop: 10 }}>
          {total === 0 ? 'Nothing open to move — this member has no active CRM work.' : `Will move: ${p.open_deals} open deals · ${p.open_activities} open activities · ${p.active_leads} active leads`}
        </div>
      )}
    </div>
  )
}
