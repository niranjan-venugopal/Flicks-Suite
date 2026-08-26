'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon } from '@/components/proto'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCurrentUser, useTrustDevice } from '@/lib/api/queries/use-auth'
import { useMyConsents } from '@/lib/api/queries/use-consent'

const DISMISS_KEY = 'fs-trust-device-dismissed'

/**
 * Post-login "stay signed in?" prompt (Zoho-style, founder decision). Shows
 * once per browser session when the current device isn't trusted yet;
 * accepting upgrades the session to the 180-day window and remembers the
 * device, so future logins never ask again. Dismissal is per-tab-session —
 * it re-asks after the next sign-in, per the founder's requirement.
 */
export function TrustDevicePrompt() {
  const { data: me } = useCurrentUser()
  const trust = useTrustDevice()
  const { toast } = useToast()
  // Radix dialogs set body-level pointer-events: none while open, which
  // deadens the (non-Radix) terms ReacceptanceGate painting above this
  // dialog. Never open while a terms re-acceptance is due — the gate goes
  // first, and accepting it invalidates the consents query, which re-renders
  // this prompt into view. Same query key as the gate → one network call.
  const consents = useMyConsents(!!me)
  const consentState = consents.data?.data
  // Start dismissed (matches the SSR render → no hydration mismatch), then
  // read the per-tab-session flag on mount.
  const [dismissed, setDismissed] = useState(true)
  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === '1')
    } catch {
      /* storage unavailable → never nag */
    }
  }, [])

  const role = (
    me?.currentMembership?.role ?? me?.memberships?.[0]?.role ?? ''
  ).toLowerCase()
  const show =
    !!me &&
    me.deviceTrusted === false &&
    !dismissed &&
    !me.impersonatorUserId &&
    role !== 'fam' &&
    role !== 'super_admin' &&
    !!consentState &&
    !consentState.requires_reacceptance

  if (!show) return null

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setDismissed(true)
  }

  const accept = async () => {
    try {
      await trust.mutateAsync()
      toast({
        title: "You'll stay signed in on this device",
        description: 'For about 180 days — no codes needed until then.',
      })
      dismiss()
    } catch (err) {
      toast({
        title: 'Could not remember this device',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icon.shield size={16} style={{ color: 'var(--blue)' }} />
              Stay signed in on this device?
            </span>
          </DialogTitle>
        </DialogHeader>
        <p className="t-mute text-sm" style={{ marginTop: 0 }}>
          Skip the sign-in code on this device for the next <strong>180 days</strong>.
          Only choose this on a device that's yours.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Btn kind="ghost" onClick={dismiss} disabled={trust.isPending}>
            Not now
          </Btn>
          <Btn kind="primary" onClick={accept} disabled={trust.isPending}>
            {trust.isPending ? 'Saving…' : 'Yes, stay signed in'}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
