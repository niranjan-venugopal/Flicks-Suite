'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill } from '@/components/proto'
import { PmAv } from '@/components/pm/projects'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useRsvp, type AttendeeResponse, type CalendarFeedItem } from '@/lib/api/queries/use-calendar'
import { EVENTS, track } from '@/lib/analytics/posthog'
import {
  TYPE_LABEL,
  durationLabel,
  fmtWhen,
  kindColor,
  providerLabel,
  responseLabel,
  responseTone,
} from './calendar-utils'

const RESPONSE_DOT: Record<AttendeeResponse, string> = {
  accepted: 'var(--green)',
  declined: 'var(--coral)',
  tentative: 'var(--yellow)',
  pending: 'var(--text-faint)',
}

/**
 * The detail card — inside the chip popover and the deep-link modal. Read-only
 * sources (holiday, leave, birthday, CRM) get a compact card with their link;
 * events get organizer, attendees with reply dots, Join, RSVP, Edit, Cancel.
 */
export function EventDetail({
  item,
  onClose,
  onEdit,
  onCancel,
}: {
  item: CalendarFeedItem
  onClose?: () => void
  onEdit?: (item: CalendarFeedItem) => void
  onCancel?: (item: CalendarFeedItem) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const { currentUser } = useAuthStore()
  const rsvp = useRsvp()
  const isEvent = item.type === 'event' || item.type === 'meeting'
  const color = kindColor(item)
  const attendees = item.attendees ?? []
  const iAmAttendee = !!currentUser?.id && attendees.some((a) => a.userId === currentUser.id)
  const isOrganizer = !!currentUser?.id && item.organizer?.userId === currentUser.id
  const meta = (item.meta ?? {}) as Record<string, unknown>

  const answer = async (response: Exclude<AttendeeResponse, 'pending'>) => {
    if (rsvp.isPending || item.myResponse === response) return
    try {
      await rsvp.mutateAsync({ id: item.id, response })
      track(EVENTS.CALENDAR_RSVP, { response })
    } catch (e) {
      toast({ title: 'Could not send your reply', description: e instanceof Error ? e.message : 'Try again', variant: 'destructive' })
    }
  }

  const openLink = () => {
    if (!item.link) return
    onClose?.()
    router.push(item.link)
  }

  const kindLabel = isEvent
    ? item.type === 'meeting'
      ? 'Meeting'
      : 'Event'
    : TYPE_LABEL[item.type]

  return (
    <div style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }} data-calendar-detail={item.id}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: color, flexShrink: 0, minHeight: 34 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
            <Pill tone={isEvent ? (item.type === 'meeting' ? 'blue' : 'green') : item.type === 'holiday' ? 'yellow' : item.type === 'team_leave' || item.type === 'birthday' ? 'purple' : ''}>
              {kindLabel}
            </Pill>
            {item.status === 'pending' && <Pill tone="yellow">Pending approval</Pill>}
            {item.type === 'crm_activity' && meta.completed === true && <Pill tone="green">Done</Pill>}
            {item.visibility === 'company' && isEvent && <Pill>Everyone</Pill>}
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.25, letterSpacing: '-0.01em', wordBreak: 'break-word' }}>{item.title}</div>
        </div>
        {onClose && (
          <div style={{ margin: '-6px -8px 0 0' }}>
            <Btn kind="ghost" size="sm" icon={<Icon.x size={14} />} onClick={onClose} />
          </div>
        )}
      </div>

      {/* When / where */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, color: 'var(--text-2)', fontWeight: 600 }}>
        <Row icon={<Icon.clock size={13} />}>
          {fmtWhen(item)}
          <span style={{ color: 'var(--text-faint)' }}> · {durationLabel(item)}</span>
        </Row>
        {item.location && <Row icon={<Icon.pin size={13} />}>{item.location}</Row>}
        {isEvent && item.organizer && (
          <Row icon={<PmAv name={item.organizer.name} src={item.organizer.avatarUrl} size={15} />}>
            Organized by <b style={{ color: 'var(--text)' }}>{isOrganizer ? 'you' : item.organizer.name}</b>
          </Row>
        )}
        {item.type === 'team_leave' && typeof meta.leaveTypeName === 'string' && (
          <Row icon={<Icon.people size={13} />}>{meta.leaveTypeName}{typeof meta.totalDays === 'number' || typeof meta.totalDays === 'string' ? ` · ${meta.totalDays} day(s)` : ''}</Row>
        )}
        {item.type === 'my_leave' && typeof meta.leaveTypeName === 'string' && (
          <Row icon={<Icon.cal size={13} />}>{meta.leaveTypeName}</Row>
        )}
        {item.type === 'holiday' && (
          <Row icon={<Icon.sun size={13} />}>
            {meta.blocking === false ? 'Optional holiday' : 'Company holiday'}
            {meta.locationScoped === true ? ' · your location' : ''}
          </Row>
        )}
        {item.type === 'crm_activity' && typeof meta.dealTitle === 'string' && (
          <Row icon={<Icon.funnel size={13} />}>{meta.dealTitle}</Row>
        )}
      </div>

      {item.description && (
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
          {item.description}
        </div>
      )}

      {/* Meeting link */}
      {isEvent && (item.meetingProvider ?? 'none') !== 'none' && (
        item.meetingUrl ? (
          <Btn
            kind="primary"
            size="sm"
            icon={<Icon.link size={13} />}
            onClick={() => window.open(item.meetingUrl ?? '', '_blank', 'noopener,noreferrer')}
          >
            Join {providerLabel(item.meetingProvider)}
          </Btn>
        ) : (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8,
              background: 'var(--surf-1)', border: '1px dashed var(--bord-2)', fontSize: 12, fontWeight: 700, color: 'var(--text-2)',
            }}
          >
            <Icon.link size={13} style={{ color: 'var(--text-mute)' }} />
            <span style={{ flex: 1 }}>{providerLabel(item.meetingProvider)} · link pending</span>
            {item.canEdit && onEdit && (
              <Btn kind="secondary" size="sm" onClick={() => onEdit(item)}>Add link</Btn>
            )}
          </div>
        )
      )}

      {/* Attendees */}
      {isEvent && attendees.length > 0 && (
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-mute)', marginBottom: 6 }}>
            {attendees.length} {attendees.length === 1 ? 'attendee' : 'attendees'}
            <span style={{ fontWeight: 700, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>
              · {attendees.filter((a) => a.response === 'accepted').length} accepted
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 150, overflowY: 'auto' }}>
            {attendees.map((a) => (
              <div key={a.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700 }}>
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <PmAv name={a.name} src={a.avatarUrl} size={20} />
                  <span
                    title={responseLabel(a.response)}
                    style={{ position: 'absolute', right: -2, bottom: -2, width: 8, height: 8, borderRadius: '50%', background: RESPONSE_DOT[a.response], border: '1.5px solid #101020' }}
                  />
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: a.userId === currentUser?.id ? 'var(--text)' : 'var(--text-2)' }}>
                  {a.userId === currentUser?.id ? 'You' : a.name}
                  {a.userId === item.organizer?.userId && <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}> · organizer</span>}
                  {a.isOptional && <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}> · optional</span>}
                </span>
                <span style={{ fontSize: 10.5, color: RESPONSE_DOT[a.response], fontWeight: 800 }}>{responseLabel(a.response)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* RSVP */}
      {isEvent && iAmAttendee && !isOrganizer && (
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-mute)', marginBottom: 6 }}>
            Your reply {item.myResponse && item.myResponse !== 'pending' && <Pill tone={responseTone(item.myResponse)} style={{ marginLeft: 6 }}>{responseLabel(item.myResponse)}</Pill>}
          </div>
          <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 9 }}>
            {(
              [
                ['accepted', 'Accept', 'var(--green)'],
                ['tentative', 'Tentative', 'var(--yellow)'],
                ['declined', 'Decline', 'var(--coral)'],
              ] as const
            ).map(([key, label, c]) => {
              const on = item.myResponse === key
              return (
                <button
                  key={key}
                  type="button"
                  data-rsvp={key}
                  disabled={rsvp.isPending}
                  onClick={() => void answer(key)}
                  style={{
                    flex: 1, padding: '6px 8px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    background: on ? 'var(--surf-3)' : 'transparent', color: on ? c : 'var(--text-2)', fontSize: 11.5, fontWeight: 800,
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Footer actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
        {!isEvent && item.link && (
          <Btn kind="secondary" size="sm" icon={<Icon.arrow size={12} />} onClick={openLink}>
            {item.type === 'crm_activity' ? 'Open in CRM' : item.type === 'my_leave' ? 'Open leave' : 'Open profile'}
          </Btn>
        )}
        <span style={{ flex: 1 }} />
        {isEvent && item.canEdit && onEdit && (
          <Btn kind="secondary" size="sm" icon={<Icon.edit size={12} />} onClick={() => onEdit(item)}>Edit</Btn>
        )}
        {isEvent && item.canEdit && onCancel && (
          <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} onClick={() => onCancel(item)} style={{ color: 'var(--coral)' }}>
            Cancel {item.type === 'meeting' ? 'meeting' : 'event'}
          </Btn>
        )}
      </div>
    </div>
  )
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ color: 'var(--text-mute)', display: 'inline-flex', width: 16, justifyContent: 'center', flexShrink: 0 }}>{icon}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}
