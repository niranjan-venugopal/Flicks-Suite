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
import { Btn } from '@/components/proto'
import { useICalUrl } from '@/lib/api/queries/use-calendar'

/** The read-only iCal feed URL for Google / Outlook / Apple Calendar. */
export function SubscribeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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
          <DialogTitle>Subscribe in Google Calendar / Outlook / Apple Calendar</DialogTitle>
          <DialogDescription>
            Paste this URL into your calendar app (&quot;From URL&quot; / &quot;Subscribe&quot;) to get holidays, your leave and
            the meetings you organize or accepted as a live, read-only feed.
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
