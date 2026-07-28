'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Btn, Icon, SectionHead } from '@/components/proto'
import { useICalUrl } from '@/lib/api/queries/use-calendar'
import { MonthCalendar } from '@/components/attendance/MonthCalendar'
import { MonthNav } from '@/components/ui/month-nav'

// ─────────────────────────────────────────────────────────
// The ONE calendar (modernized design): attendance status dots + holidays +
// my/team leave in a single month grid with the day-detail popover.
// ─────────────────────────────────────────────────────────

export default function CalendarPage() {
  const [cursor, setCursor] = useState(new Date())
  const [subscribeOpen, setSubscribeOpen] = useState(false)

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Calendar"
          sub="Attendance, holidays, leaves and team availability — one calendar"
          right={
            <Btn kind="secondary" size="sm" icon={<Icon.cal size={13} />} onClick={() => setSubscribeOpen(true)}>
              Subscribe (iCal)
            </Btn>
          }
        />

        {/* Month toolbar — title opens the month/year chooser */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <MonthNav cursor={cursor} onChange={setCursor} />
          <span style={{ flex: 1 }} />
          <Btn kind="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Btn>
        </div>

        <MonthCalendar cursor={cursor} />
      </div>

      <SubscribeDialog open={subscribeOpen} onOpenChange={setSubscribeOpen} />
    </div>
  )
}

// ─── Subscribe dialog ──────────────────────────────────────────────────────

function SubscribeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const ical = useICalUrl()
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!ical.data?.url) return
    try {
      await navigator.clipboard.writeText(ical.data.url)
      setCopied(true)
      toast({ title: 'Copied', description: 'iCal URL on clipboard.' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: 'Could not copy', variant: 'destructive' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscribe in Google Calendar / Apple Calendar</DialogTitle>
          <DialogDescription>
            Paste this URL into your calendar app to get holidays + your leaves
            as a live feed.
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            readOnly
            className="input"
            value={ical.data?.url ?? 'Loading…'}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Btn
            kind="secondary"
            icon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            onClick={handleCopy}
            disabled={!ical.data?.url}
          >
            {copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
        <DialogFooter>
          <Btn kind="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Btn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
