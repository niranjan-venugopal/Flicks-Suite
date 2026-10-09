'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Avatar, Btn, Icon, Pill, SectionHead, type PillTone } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useToast } from '@/components/ui/use-toast'
import {
  useFamUser,
  useFamUserAuthEvents,
  useClearUserLockout,
  useSendSignInLink,
  useSignOutEverywhere,
} from '@/lib/api/queries/use-fam'
import { formatDate, timeAgo } from '@/lib/utils'

/**
 * Round R R2 — one person across every company: profile, seats, what is
 * keeping them out, live sessions, trusted devices, sign-in history, and the
 * three support actions (clear lockout · send sign-in link · sign out
 * everywhere). Every action is written to the platform audit log with the
 * admin's IP and browser.
 */

function roleTone(r: string): PillTone {
  switch (r) {
    case 'fam':
    case 'super_admin': return 'purple'
    case 'owner':       return 'yellow'
    case 'admin':       return 'blue'
    case 'manager':     return 'green'
    case 'finance':     return 'coral'
    default:            return ''
  }
}
function seatTone(s: string): PillTone {
  switch (s) {
    case 'active':      return 'green'
    case 'invited':     return 'yellow'
    case 'deactivated': return 'coral'
    default:            return ''
  }
}
function tenantTone(s: string): PillTone {
  switch (s) {
    case 'active':    return 'green'
    case 'trialing':  return 'blue'
    case 'past_due':  return 'yellow'
    case 'suspended':
    case 'canceled':  return 'coral'
    default:          return ''
  }
}
function eventTone(t: string): PillTone {
  if (t.endsWith('_failed') || t === 'token_revoked' || t === 'account_locked') return 'coral'
  if (t === 'login_success' || t === 'account_unlocked' || t === 'magic_link_consumed') return 'green'
  if (t === 'tenant_selected' || t === 'device_trusted') return 'blue'
  return ''
}
const EVENT_LABEL: Record<string, string> = {
  otp_requested: 'Code requested',
  otp_failed: 'Wrong code',
  magic_link_requested: 'Sign-in link sent',
  magic_link_consumed: 'Signed in via link',
  login_success: 'Signed in',
  login_failed: 'Sign-in failed',
  logout: 'Signed out',
  token_refreshed: 'Session refreshed',
  token_revoked: 'Session ended',
  tenant_selected: 'Switched company',
  account_unlocked: 'Lockout cleared',
}

export default function FamUserPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? null
  const user = useFamUser(id)
  const { toast } = useToast()
  const [page, setPage] = useState(1)
  const events = useFamUserAuthEvents(id, page, 25)
  const clearLockout = useClearUserLockout()
  const sendLink = useSendSignInLink()
  const signOut = useSignOutEverywhere()
  const [confirm, setConfirm] = useState<'link' | 'signout' | null>(null)

  if (user.isLoading) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-mute)' }}>
        <Loader2 className="w-5 h-5 animate-spin" style={{ display: 'inline-block' }} />
      </div>
    )
  }
  if (!user.data) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: 720, margin: '0 auto' }}>
        <SectionHead title="Person not found" sub="The link may be stale, or the ID is wrong." />
        <Link href="/fam/tenants" style={{ textDecoration: 'none' }}>
          <Btn kind="secondary" size="sm" icon={<Icon.chevL size={12} />}>Back to tenants</Btn>
        </Link>
      </div>
    )
  }

  const u = user.data
  const lock = u.lockout
  const liveDevices = u.devices.filter((d) => d.active)
  const fail = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })

  const doClear = () =>
    clearLockout.mutate(u.id, {
      onSuccess: (r) =>
        toast({
          title: 'Lockout cleared',
          description: `${r.otpRowsReset} code${r.otpRowsReset === 1 ? '' : 's'} reset${r.redisCleared ? ', rate limits dropped' : ''}. They can request a new code now.`,
        }),
      onError: fail('Could not clear the lockout'),
    })
  const doSendLink = () =>
    sendLink.mutate(u.id, {
      onSuccess: (r) => {
        setConfirm(null)
        toast({ title: 'Sign-in link sent', description: `Emailed to ${u.email} · valid until ${formatDate(r.expiresAt)}.` })
      },
      onError: fail('Could not send the link'),
    })
  const doSignOut = () =>
    signOut.mutate(u.id, {
      onSuccess: (r) => {
        setConfirm(null)
        toast({
          title: 'Signed out everywhere',
          description: `${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? '' : 's'} ended, ${r.devicesRevoked} trusted device${r.devicesRevoked === 1 ? '' : 's'} forgotten.`,
        })
      },
      onError: fail('Could not sign them out'),
    })

  const total = events.data?.pagination.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / 25))

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        {/* Header */}
        <div className="card" style={{ padding: '20px 22px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', background: 'linear-gradient(135deg, rgba(62,123,250,.08), rgba(155,123,250,.04))' }}>
          <Link
            href="/fam/tenants"
            style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surf-1)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-2)' }}
            aria-label="Back"
          >
            <Icon.chevL size={14} />
          </Link>
          <Avatar name={u.fullName ?? u.email} size="lg" src={u.avatarUrl ?? undefined} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }} data-testid="fam-user-name">{u.fullName ?? u.email}</h1>
              <Pill tone={u.status === 'active' ? 'green' : 'coral'} dot>{u.status}</Pill>
              {u.isPlatformAdmin && <Pill tone="purple">Platform admin</Pill>}
              {lock.locked && <Pill tone="coral" dot>Locked out</Pill>}
            </div>
            <div style={{ marginTop: 5, fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', display: 'flex', gap: 12, flexWrap: 'wrap', fontFamily: 'var(--font-mono)' }}>
              <span>{u.email}</span>
              {u.phone && <><span>·</span><span>{u.phone}</span></>}
              <span>·</span>
              <span>Last sign-in {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</span>
              <span>·</span>
              <span>Joined {formatDate(u.createdAt)}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn kind="secondary" size="sm" icon={<Icon.key size={13} />} onClick={doClear} disabled={clearLockout.isPending} data-testid="user-clear-lockout">
              {clearLockout.isPending ? 'Clearing…' : 'Clear sign-in lockout'}
            </Btn>
            <Btn kind="secondary" size="sm" icon={<Icon.mail size={13} />} onClick={() => setConfirm('link')} disabled={u.status !== 'active'} data-testid="user-send-link">
              Send sign-in link
            </Btn>
            <Btn kind="danger" size="sm" icon={<Icon.out size={13} />} onClick={() => setConfirm('signout')} data-testid="user-sign-out-everywhere">
              Sign out everywhere
            </Btn>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 14, alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 14 }}>
            {/* Companies */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)' }}>
                <SectionHead title="Companies" sub={`${u.companies.length} seat${u.companies.length === 1 ? '' : 's'}`} />
              </div>
              {u.companies.length === 0 ? (
                <div className="t-mute" style={{ padding: 24, fontSize: 12.5, textAlign: 'center' }}>No company seats.</div>
              ) : (
                <table className="tbl" style={{ width: '100%' }}>
                  <thead><tr><th>Company</th><th>Role</th><th>Seat</th><th>Joined</th><th /></tr></thead>
                  <tbody>
                    {u.companies.map((c) => (
                      <tr key={c.membershipId} data-testid="user-company-row">
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Avatar name={c.tenantName} size="sm" src={c.tenantLogoUrl ?? undefined} />
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 800 }}>{c.tenantName}</div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', fontFamily: 'var(--font-mono)' }}>{c.tenantSlug}</span>
                                <Pill tone={tenantTone(c.tenantStatus)} dot>{c.tenantStatus.replace('_', ' ')}</Pill>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td><Pill tone={roleTone(c.role)} dot>{c.role.replace('_', ' ')}</Pill></td>
                        <td>
                          <Pill tone={seatTone(c.status)} dot>{c.status}</Pill>
                          {c.accessExpiresAt && <div style={{ fontSize: 10.5, color: 'var(--text-mute)', marginTop: 3 }}>until {formatDate(c.accessExpiresAt)}</div>}
                        </td>
                        <td style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>{c.acceptedAt ? timeAgo(c.acceptedAt) : c.invitedAt ? `invited ${timeAgo(c.invitedAt)}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <Link href={`/fam/tenants/${c.tenantId}`} style={{ textDecoration: 'none' }}>
                            <Btn kind="ghost" size="sm" iconRight={<Icon.arrow size={12} />}>Open</Btn>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Sign-in history */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bord)' }}>
                <SectionHead title="Sign-in history" sub={`${total} event${total === 1 ? '' : 's'} · newest first`} />
              </div>
              {events.isLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-mute)' }}><Loader2 className="w-4 h-4 animate-spin" style={{ display: 'inline-block' }} /></div>
              ) : (events.data?.data.length ?? 0) === 0 ? (
                <div className="t-mute" style={{ padding: 24, fontSize: 12.5, textAlign: 'center' }}>Nothing recorded yet.</div>
              ) : (
                <table className="tbl" style={{ width: '100%' }}>
                  <thead><tr><th>When</th><th>Event</th><th>Device</th><th>IP</th><th>Details</th></tr></thead>
                  <tbody>
                    {events.data!.data.map((e) => (
                      <tr key={e.id} data-testid="auth-event-row">
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)', whiteSpace: 'nowrap' }} title={e.createdAt}>{timeAgo(e.createdAt)}</td>
                        <td><Pill tone={eventTone(e.eventType)} dot>{EVENT_LABEL[e.eventType] ?? e.eventType.replace(/_/g, ' ')}</Pill></td>
                        <td style={{ fontSize: 11.5, fontWeight: 600 }}>{e.deviceName ?? '—'}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>{e.ipAddress ?? '—'}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-mute)', wordBreak: 'break-word', maxWidth: 260 }}>{e.metadata ? JSON.stringify(e.metadata) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {totalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid var(--bord)', background: 'var(--bg-2)' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>Page {page} of {totalPages}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn kind="ghost" size="sm" icon={<Icon.chevL size={12} />} disabled={page <= 1 || events.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Btn>
                    <Btn kind="ghost" size="sm" iconRight={<Icon.chevR size={12} />} disabled={page >= totalPages || events.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Btn>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 14 }}>
            {/* Lockout */}
            <div className="card" style={{ padding: 18 }} data-testid="user-lockout">
              <SectionHead title="Can they sign in?" sub={lock.locked ? 'Something is keeping them out' : 'Nothing is blocking them'} />
              <dl style={{ margin: '12px 0 0', display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 9, columnGap: 12, fontSize: 12.5 }}>
                <Row k="Wrong-code lockout" v={lock.otpAttemptsExhausted ? <Pill tone="coral" dot>locked</Pill> : <Pill tone="green" dot>clear</Pill>} />
                <Row k="Codes this hour" v={<span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: lock.otpQuotaBlocked ? 'var(--coral)' : 'var(--text)' }}>{lock.otpHourlyCount} / {lock.otpHourlyLimit}</span>} />
                {u.isPlatformAdmin && (
                  <Row k="Authenticator lock" v={lock.totpLockedUntil ? <Pill tone="coral" dot>until {formatDate(lock.totpLockedUntil)}</Pill> : <Pill tone="green" dot>clear</Pill>} />
                )}
                <Row k="Two-factor" v={u.isPlatformAdmin ? (u.totpEnrolledAt ? <Pill tone="green" dot>enrolled</Pill> : <Pill tone="yellow" dot>not enrolled</Pill>) : <span className="t-mute">n/a</span>} />
              </dl>
              <p className="t-mute" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
                <b>Clear sign-in lockout</b> drops the hourly code limit, resets the wrong-code counter and the authenticator lock. <b>Send sign-in link</b> emails a 30-minute link that skips the code limit altogether.
              </p>
            </div>

            {/* Sessions */}
            <div className="card" style={{ padding: 18 }} data-testid="user-sessions">
              <SectionHead title="Live sessions" sub={`${u.sessions.length} open`} />
              {u.sessions.length === 0 ? (
                <div className="t-mute" style={{ padding: '14px 0 0', fontSize: 12.5 }}>Not signed in anywhere.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
                  {u.sessions.map((s, i) => (
                    <div key={s.id} style={{ padding: '10px 0', borderBottom: i < u.sessions.length - 1 ? '1px solid var(--bord)' : 'none', display: 'flex', gap: 10, alignItems: 'center' }}>
                      <Icon.laptop size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 800, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          {s.deviceName ?? 'Unknown device'}
                          {s.tenantName && <span className="t-mute" style={{ fontWeight: 600 }}>· {s.tenantName}</span>}
                          {s.trusted && <Pill tone="blue">trusted</Pill>}
                          {s.mfa && <Pill tone="green">2FA</Pill>}
                          {s.impersonated && <Pill tone="coral">impersonation</Pill>}
                        </div>
                        <div className="t-mute" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          {s.ipAddress ?? '—'} · last used {s.lastUsedAt ? timeAgo(s.lastUsedAt) : timeAgo(s.createdAt)} · expires {formatDate(s.expiresAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Devices */}
            <div className="card" style={{ padding: 18 }} data-testid="user-devices">
              <SectionHead title="Trusted devices" sub={`${liveDevices.length} remembered`} />
              {liveDevices.length === 0 ? (
                <div className="t-mute" style={{ padding: '14px 0 0', fontSize: 12.5 }}>No device is remembered — every sign-in asks again.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
                  {liveDevices.map((d, i) => (
                    <div key={d.id} style={{ padding: '10px 0', borderBottom: i < liveDevices.length - 1 ? '1px solid var(--bord)' : 'none' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800 }}>{d.deviceName ?? 'Device'}</div>
                      <div className="t-mute" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                        {d.ipAddress ?? '—'} · last used {d.lastUsedAt ? timeAgo(d.lastUsedAt) : '—'}{d.expiresAt ? ` · until ${formatDate(d.expiresAt)}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'link'}
        onClose={() => setConfirm(null)}
        title={`Email ${u.email} a sign-in link?`}
        body="A 30-minute link that signs them straight in, skipping the code limit. Use it when they are stuck behind “a code was just sent”."
        confirmLabel="Send link"
        loading={sendLink.isPending}
        loadingLabel="Sending…"
        onConfirm={doSendLink}
      />
      <ConfirmDialog
        open={confirm === 'signout'}
        onClose={() => setConfirm(null)}
        title={`Sign ${u.fullName ?? u.email} out everywhere?`}
        body="Every open session in every company is ended — a screen they still have open drops within 15 minutes, when its short-lived token expires — and every remembered device is forgotten. They can sign in again right away."
        confirmLabel="Sign out everywhere"
        danger
        loading={signOut.isPending}
        loadingLabel="Signing out…"
        onConfirm={doSignOut}
      />
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--text-mute)', fontWeight: 700 }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 700, color: 'var(--text)', textAlign: 'right' }}>{v}</dd>
    </>
  )
}
