'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Calendar as CalendarIcon,
  Copy,
  Check,
  Loader2,
  ExternalLink,
} from 'lucide-react'
import {
  Calendar,
  dateFnsLocalizer,
  Views,
  type View,
} from 'react-big-calendar'
import { format, parse, startOfWeek, getDay, addDays } from 'date-fns'
import { enUS } from 'date-fns/locale'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageGlows } from '@/components/layout/PageGlows'
import { useToast } from '@/components/ui/use-toast'
import {
  useCalendarEvents,
  useICalUrl,
  type CalendarEvent,
} from '@/lib/api/queries/use-calendar'

const locales = { 'en-US': enUS }
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 1 }), // Mon-first
  getDay,
  locales,
})

interface RBCEvent {
  id: string
  title: string
  start: Date
  end: Date // exclusive in rbc semantics
  allDay: boolean
  resource: CalendarEvent
}

export default function CalendarPage() {
  const [date, setDate] = useState(new Date())
  const [view, setView] = useState<View>(Views.MONTH)
  const [subscribeOpen, setSubscribeOpen] = useState(false)

  const range = useMemo(() => {
    // Fetch a generous window so navigation is snappy
    const start = new Date(date.getFullYear(), date.getMonth() - 1, 1)
    const end = new Date(date.getFullYear(), date.getMonth() + 2, 0)
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    }
  }, [date])

  const events = useCalendarEvents(range.from, range.to)

  const rbcEvents: RBCEvent[] = useMemo(() => {
    if (!events.data) return []
    return events.data.map((e) => ({
      id: e.id,
      title: e.title,
      // rbc DTEND is exclusive; add a day to inclusive end
      start: new Date(`${e.startDate}T00:00:00`),
      end: addDays(new Date(`${e.endDate}T00:00:00`), 1),
      allDay: true,
      resource: e,
    }))
  }, [events.data])

  return (
    <div className="relative min-h-full">
      <PageGlows />
      <div className="relative z-10 p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start justify-between gap-4 mb-6 flex-wrap"
        >
          <div>
            <h1 className="text-3xl font-bold text-white font-gilroy">
              Calendar
            </h1>
            <p className="text-brand-muted mt-1">
              Holidays, your leaves, and team availability — one view
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={() => setSubscribeOpen(true)}
            className="shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
            Subscribe (Google / Outlook)
          </Button>
        </motion.div>

        {/* Legend */}
        <div className="glass rounded-xl px-4 py-3 mb-4 flex items-center gap-5 flex-wrap text-sm font-gilroy">
          <LegendDot color="#ef4444" label="Holiday" />
          <LegendDot color="#6366f1" label="My leave (approved)" />
          <LegendDot color="#fbbf24" label="My leave (pending)" />
          <LegendDot color="#94a3b8" label="Team on leave" />
        </div>

        {/* Calendar */}
        <div className="glass rounded-xl p-4">
          {events.isLoading ? (
            <div className="py-24 flex items-center justify-center text-white/40">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading calendar…
            </div>
          ) : (
            <div style={{ height: 680 }}>
              <Calendar
                localizer={localizer}
                events={rbcEvents}
                date={date}
                onNavigate={(d) => setDate(d)}
                view={view}
                onView={(v) => setView(v)}
                views={[Views.MONTH, Views.WEEK, Views.AGENDA]}
                popup
                eventPropGetter={eventStyle}
                tooltipAccessor={(e) =>
                  buildTooltip((e as RBCEvent).resource)
                }
              />
            </div>
          )}
        </div>
      </div>

      <SubscribeDialog open={subscribeOpen} onOpenChange={setSubscribeOpen} />
    </div>
  )
}

function eventStyle(event: object): {
  style: React.CSSProperties
  className?: string
} {
  const e = (event as RBCEvent).resource
  const isPending = e.type === 'my_leave' && e.status === 'pending'
  const baseColor = isPending ? '#fbbf24' : (e.color ?? '#6366f1')
  return {
    style: {
      backgroundColor: `${baseColor}33`, // 20% alpha
      border: `1px solid ${baseColor}`,
      color: '#fff',
      borderRadius: 4,
      padding: '2px 6px',
      fontSize: 11,
    },
  }
}

function buildTooltip(e: CalendarEvent): string {
  const parts = [e.title]
  if (e.meta?.['reason']) parts.push(`Reason: ${e.meta['reason']}`)
  if (e.meta?.['totalDays']) parts.push(`Days: ${e.meta['totalDays']}`)
  return parts.join(' · ')
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-white/70">
      <span
        className="w-3 h-3 rounded-sm"
        style={{ background: `${color}33`, border: `1px solid ${color}` }}
      />
      {label}
    </span>
  )
}

function SubscribeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const ical = useICalUrl()
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()

  const copyUrl = async () => {
    if (!ical.data?.url) return
    try {
      await navigator.clipboard.writeText(ical.data.url)
      setCopied(true)
      toast({
        title: 'Copied',
        description: 'Paste it into Google Calendar to subscribe.',
      })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Select the URL manually and copy it.',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe to your calendar</DialogTitle>
          <DialogDescription>
            Add this URL to Google Calendar (Other calendars → From URL) or
            Outlook (Add calendar → Subscribe from web). Updates roll in
            automatically — no need to re-import.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {ical.isLoading ? (
            <div className="text-white/40 text-sm font-gilroy flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating subscription link…
            </div>
          ) : (
            <div className="rounded-md bg-white/[0.04] border border-white/[0.08] p-3 break-all font-mono text-xs text-white/80">
              {ical.data?.url}
            </div>
          )}
          <div className="text-xs text-white/40 font-gilroy">
            <CalendarIcon className="w-3 h-3 inline mr-1" />
            The URL is unique to you and your tenant. Anyone with the URL can
            read your calendar — keep it private.
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={copyUrl} disabled={!ical.data?.url}>
            {copied ? (
              <>
                <Check className="w-4 h-4" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" /> Copy URL
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
