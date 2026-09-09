'use client'

import { useState, type CSSProperties, type MouseEvent } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AvatarStack } from '@/components/proto'
import type { CalendarFeedItem } from '@/lib/api/queries/use-calendar'
import { EventDetail } from './EventDetail'
import { fmtTime, kindColor, tint } from './calendar-utils'

export interface ChipActions {
  onEdit: (item: CalendarFeedItem) => void
  onCancel: (item: CalendarFeedItem) => void
}

/**
 * One calendar item as a month/agenda chip or a week/day block. Owns the
 * detail popover; Edit / Cancel close it first because the composer and the
 * confirm dialog are proto Modals (z 1000) that would paint under the
 * popover (z-float 1500).
 */
export function EventChip({
  item,
  variant,
  actions,
  style,
  side,
}: {
  item: CalendarFeedItem
  variant: 'chip' | 'block'
  actions: ChipActions
  style?: CSSProperties
  side?: 'left' | 'right' | 'top' | 'bottom'
}) {
  const [open, setOpen] = useState(false)
  const color = kindColor(item)
  const isEvent = item.type === 'event' || item.type === 'meeting'
  const declined = item.myResponse === 'declined'
  const attendees = (item.attendees ?? []).filter((a) => a.response !== 'declined')
  const blockHeight = typeof style?.height === 'number' ? style.height : 999
  const short = variant === 'block' && blockHeight < 40

  const stop = (e: MouseEvent) => e.stopPropagation()

  const trigger =
    variant === 'chip' ? (
      <button
        type="button"
        onClick={stop}
        title={item.title}
        data-calendar-chip={item.type}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          height: 20,
          padding: '0 6px',
          borderRadius: 5,
          border: 'none',
          background: open ? tint(color, 28) : tint(color, 14),
          color: 'var(--text)',
          fontSize: 11,
          fontWeight: 700,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          opacity: declined ? 0.5 : 1,
          textDecoration: declined ? 'line-through' : 'none',
          ...style,
        }}
      >
        <span style={{ width: 3, height: 12, borderRadius: 2, background: color, flexShrink: 0 }} />
        {!item.allDay && (
          <span style={{ color: 'var(--text-2)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {fmtTime(item.startAt)}
          </span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
      </button>
    ) : (
      <button
        type="button"
        onClick={stop}
        title={`${item.title} · ${fmtTime(item.startAt)}–${fmtTime(item.endAt)}`}
        data-calendar-block={item.type}
        style={{
          position: 'absolute',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 2,
          padding: short ? '2px 6px 2px 7px' : '4px 6px 4px 8px',
          justifyContent: short ? 'center' : 'flex-start',
          borderRadius: 7,
          border: `1px solid ${tint(color, 45)}`,
          borderLeft: `3px solid ${color}`,
          background: open ? tint(color, 32) : tint(color, 18),
          color: 'var(--text)',
          cursor: 'pointer',
          textAlign: 'left',
          overflow: 'hidden',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
          opacity: declined ? 0.5 : 1,
          boxShadow: open ? `0 0 0 2px ${tint(color, 40)}` : 'none',
          ...style,
        }}
      >
        {short ? (
          // ≤ 30-minute blocks: one line, title first, time trailing.
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, lineHeight: 1.2 }}>
            <span style={{ fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: declined ? 'line-through' : 'none' }}>
              {item.title}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {fmtTime(item.startAt)}
            </span>
          </span>
        ) : (
          <>
            <span style={{ fontSize: 11.5, fontWeight: 800, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, textDecoration: declined ? 'line-through' : 'none' }}>
              {item.title}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtTime(item.startAt)}–{fmtTime(item.endAt)}
              {item.location ? ` · ${item.location}` : ''}
            </span>
            {isEvent && attendees.length > 0 && blockHeight >= 60 && (
              <span style={{ marginTop: 2 }}>
                <AvatarStack people={attendees.map((a) => ({ name: a.name, src: a.avatarUrl ?? undefined }))} max={4} size="sm" />
              </span>
            )}
          </>
        )}
      </button>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side={side ?? (variant === 'block' ? 'right' : 'bottom')}
        collisionPadding={12}
        style={{ width: 380, maxWidth: 'calc(100vw - 24px)', padding: 0 }}
        onClick={stop}
      >
        <EventDetail
          item={item}
          onClose={() => setOpen(false)}
          onEdit={(it) => {
            setOpen(false)
            actions.onEdit(it)
          }}
          onCancel={(it) => {
            setOpen(false)
            actions.onCancel(it)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
