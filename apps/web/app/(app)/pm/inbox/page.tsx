'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon } from '@/components/proto'
import { Kbd } from '@/components/pm/glyphs'
import {
  useInbox,
  useArchiveNotification,
  useSnoozeNotification,
  useMarkRead,
  type NotificationItem,
} from '@/lib/api/queries/use-notifications'
import { useHotkeys } from '@/lib/pm/hotkeys'

// ─────────────────────────────────────────────────────────
// P9 — Inbox (§11), faithful to scr-issue-inbox.jsx ScrInbox: unread dot +
// kind tile rows that collapse per issue ("+N more"), hover/keyboard E
// archive · Z snooze, a Snoozed section, and the AC-COACH first-run overlay.
// Notifications ride REST (they are not sync-engine tables), so this page
// works identically in sync and kill-switch modes.
// ─────────────────────────────────────────────────────────

const COACH_KEY = 'pm-inbox-coach-seen'

type Kind = 'mention' | 'comment' | 'assign' | 'cycle' | 'digest' | 'done' | 'github' | 'other'

function kindOf(type: string): Kind {
  if (type === 'pm.issue.mention') return 'mention'
  if (type === 'pm.issue.comment') return 'comment'
  if (type === 'pm.issue.assigned') return 'assign'
  if (type.startsWith('pm.cycle.')) return 'cycle'
  if (type.startsWith('pm.digest')) return 'digest'
  if (type === 'pm.issue.status') return 'done'
  if (type.startsWith('pm.github.')) return 'github'
  return 'other'
}

const KIND_IC: Record<Kind, typeof Icon.bell> = {
  mention: Icon.msg,
  comment: Icon.msg,
  assign: Icon.userPlus,
  cycle: Icon.refresh,
  digest: Icon.layers,
  done: Icon.check,
  github: Icon.gitPr,
  other: Icon.bell,
}

/** "DC-12 assigned to you — title" → { key: 'DC-12', line: 'assigned to you — title' } */
function splitKey(message: string): { key: string | null; line: string } {
  const m = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/.exec(message)
  return m ? { key: m[1]!, line: m[2]! } : { key: null, line: message }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function KbdHint({ k, label }: { k: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <Kbd>{k}</Kbd>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-mute)' }}>{label}</span>
    </span>
  )
}

export default function PmInboxPage() {
  const router = useRouter()
  const { data, isLoading } = useInbox('pm')
  const archive = useArchiveNotification()
  const snooze = useSnoozeNotification()
  const markRead = useMarkRead()

  const [idx, setIdx] = useState(0)
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null)
  const [coach, setCoach] = useState(false)
  const [coachStep, setCoachStep] = useState(0)
  const [hideCoach, setHideCoach] = useState(true)

  const rows = useMemo(() => data?.items ?? [], [data])
  const snoozed = data?.snoozed ?? []
  const focus = rows[Math.min(idx, Math.max(0, rows.length - 1))] ?? null

  // First-run coach: show once, unless dismissed with "don't show again".
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.localStorage.getItem(COACH_KEY)) {
      setCoach(true)
      setCoachStep(0)
    }
  }, [])

  const open = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate(n.id)
    if (n.linkUrl) router.push(n.linkUrl)
  }
  const doSnooze = (n: NotificationItem, days: number) => {
    snooze.mutate({ id: n.id, until: new Date(Date.now() + days * 86_400_000).toISOString() })
    setSnoozeFor(null)
  }
  const closeCoach = (remember: boolean) => {
    if (remember && typeof window !== 'undefined') window.localStorage.setItem(COACH_KEY, '1')
    setCoach(false)
  }

  useHotkeys({
    j: () => setIdx((i) => Math.min(rows.length - 1, i + 1)),
    k: () => setIdx((i) => Math.max(0, i - 1)),
    arrowdown: () => setIdx((i) => Math.min(rows.length - 1, i + 1)),
    arrowup: () => setIdx((i) => Math.max(0, i - 1)),
    enter: () => { if (focus && !coach && !snoozeFor) open(focus) },
    e: () => { if (focus) { archive.mutate(focus.id); setIdx((i) => Math.min(i, Math.max(0, rows.length - 2))) } },
    z: () => { if (focus) setSnoozeFor(snoozeFor === focus.id ? null : focus.id) },
    escape: () => { setSnoozeFor(null); if (coach) closeCoach(false) },
  })

  const Row = (n: NotificationItem, i: number) => {
    const kind = kindOf(n.type)
    const Ic = KIND_IC[kind]
    const { key, line } = splitKey(n.message)
    const unread = !n.readAt
    const more = Math.max(0, (n.groupCount ?? 1) - 1)
    const focused = i === idx
    return (
      <div
        key={n.id}
        onClick={() => open(n)}
        onMouseEnter={() => setIdx(i)}
        className="pm-inbox-row"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
          borderBottom: '1px solid var(--bord)', cursor: 'pointer', position: 'relative',
          background: focused ? 'var(--surf-1)' : 'transparent', transition: 'background .12s ease-out',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: unread ? 'var(--blue)' : 'transparent', flexShrink: 0 }} />
        <span style={{
          width: 26, height: 26, borderRadius: 8, flexShrink: 0,
          background: kind === 'cycle' ? 'rgba(155,123,250,.13)' : 'var(--surf-2)',
          color: kind === 'cycle' ? 'var(--purple)' : 'var(--text-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Ic size={12} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {key && <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{key}</span>}
            <span style={{
              fontSize: 12, fontWeight: unread ? 800 : 600, color: unread ? '#fff' : 'var(--text-2)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{line}</span>
            {more > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 800, padding: '0 6px', height: 15, display: 'inline-flex', alignItems: 'center',
                borderRadius: 99, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-mute)', flexShrink: 0,
              }}>+{more} more</span>
            )}
          </div>
          {kind === 'digest' && (
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginTop: 1 }}>
              weekly category digest — expandable
            </div>
          )}
        </div>
        <span style={{ opacity: focused ? 1 : 0, display: 'inline-flex', gap: 4, transition: 'opacity .12s ease-out' }}>
          <button
            onClick={(e) => { e.stopPropagation(); archive.mutate(n.id) }}
            title="Archive (E)"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          ><Icon.check size={11} /></button>
          <button
            onClick={(e) => { e.stopPropagation(); setSnoozeFor(snoozeFor === n.id ? null : n.id) }}
            title="Snooze (Z)"
            style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          ><Icon.clock size={11} /></button>
        </span>
        {snoozeFor === n.id && (
          <div onClick={(e) => e.stopPropagation()} style={{
            position: 'absolute', right: 40, top: '100%', zIndex: 40, marginTop: -4,
            background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9, padding: 5,
            display: 'flex', flexDirection: 'column', gap: 2, minWidth: 120, boxShadow: '0 8px 24px rgba(0,0,0,.45)',
          }}>
            {[{ l: '1 day', d: 1 }, { l: '3 days', d: 3 }, { l: '1 week', d: 7 }].map((o) => (
              <button key={o.d} onClick={() => doSnooze(n, o.d)} style={{
                textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text-1)',
                background: 'none', border: 'none', borderRadius: 6, padding: '6px 9px', cursor: 'pointer',
              }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surf-2)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
              >{o.l}</button>
            ))}
          </div>
        )}
        <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)', flexShrink: 0 }}>{timeAgo(n.createdAt)}</span>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 800 }}>Unread &amp; recent</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => { setCoach(true); setCoachStep(0) }}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 10.5, fontWeight: 800, cursor: 'pointer' }}
        >How Inbox works</button>
        <KbdHint k="E" label="archive" />
        <KbdHint k="Z" label="snooze" />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
        {isLoading ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
            <Icon.refresh size={16} className="animate-spin" style={{ color: 'var(--text-mute)' }} />
          </div>
        ) : rows.length ? (
          rows.map(Row)
        ) : (
          <div style={{ padding: '34px 20px', textAlign: 'center' }}>
            <Icon.inbox size={20} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-mute)', marginBottom: 10 }}>
              Inbox zero — you only hear about issues you subscribe to.
            </div>
            <Btn kind="ghost" size="sm" onClick={() => router.push('/pm/my')}>Back to My Issues</Btn>
          </div>
        )}
      </div>

      {snoozed.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-mute)', marginBottom: 8 }}>Snoozed</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden', opacity: 0.75 }}>
            {snoozed.map((n) => {
              const { key, line } = splitKey(n.message)
              return (
                <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
                  <Icon.clock size={12} style={{ color: 'var(--yellow)' }} />
                  {key && <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-mute)' }}>{key}</span>}
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--yellow)' }}>
                    until {n.snoozedUntil ? new Date(n.snoozedUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* First-run coach (AC-COACH) */}
      {coach && (
        <div
          onClick={() => closeCoach(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
          <div onClick={(e) => e.stopPropagation()} className="card-glass" style={{ width: '100%', maxWidth: 430, borderRadius: 15, padding: '22px 24px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginBottom: 16 }}>
              {[0, 1, 2].map((s) => (
                <span key={s} style={{ width: s === coachStep ? 20 : 7, height: 7, borderRadius: 99, background: s === coachStep ? 'var(--blue)' : 'var(--surf-3)', transition: 'width .15s ease-out' }} />
              ))}
            </div>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(62,123,250,.13)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              {coachStep === 0 ? <Icon.bell size={20} /> : coachStep === 1 ? <Icon.inbox size={20} /> : <Icon.mail size={20} />}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 7 }}>
              {['You subscribe, we notify', 'One row per issue', 'Email that respects you'][coachStep]}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.65, marginBottom: 16 }}>
              {[
                'You auto-subscribe to issues you create, get assigned, or are mentioned on. Unsubscribe any issue with the bell — silence is one click.',
                'Many events on one issue collapse into a single row that updates. Low-urgency bulk becomes a digest line, not 12 pings.',
                'Mentions and assignments email after 5 minutes only if still unread in-app. Everything else folds into an hourly or daily digest you choose.',
              ][coachStep]}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center' }}>
              {coachStep < 2 ? (
                <>
                  <Btn kind="ghost" size="sm" onClick={() => closeCoach(false)}>Skip</Btn>
                  <Btn kind="primary" size="sm" onClick={() => setCoachStep((s) => s + 1)}>Next</Btn>
                </>
              ) : (
                <>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={hideCoach} onChange={(e) => setHideCoach(e.target.checked)} /> don&apos;t show again
                  </label>
                  <Btn kind="primary" size="sm" onClick={() => closeCoach(hideCoach)}>Got it</Btn>
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
