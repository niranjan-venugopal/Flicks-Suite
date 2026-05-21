'use client'

import { useState } from 'react'
import { Btn, Icon } from '@/components/proto'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Confirmation modal before starting impersonation. Matches the
 * prototype's ImpersonateModal — coral→yellow header tint, dual-audit
 * notice, reason textarea with 10-char minimum, optional ticket field,
 * read-only-by-default warning.
 */
export function ImpersonateModal({
  open,
  onOpenChange,
  targetEmail,
  onConfirm,
  isPending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetEmail: string
  onConfirm: (payload: { reason: string; ticket?: string }) => void | Promise<void>
  isPending: boolean
}) {
  const [reason, setReason] = useState('')
  const [ticket, setTicket] = useState('')
  const valid = reason.trim().length >= 10

  const handleSubmit = async () => {
    if (!valid) return
    await onConfirm({ reason: reason.trim(), ticket: ticket.trim() || undefined })
    setReason('')
    setTicket('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        style={{ padding: 0, overflow: 'hidden' }}
      >
        <DialogHeader
          style={{
            padding: '20px 24px',
            background:
              'linear-gradient(135deg, rgba(248,120,107,.15), rgba(254,216,0,.08))',
            borderBottom: '1px solid var(--bord)',
          }}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                background: 'rgba(248,120,107,.18)',
                color: 'var(--coral)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon.shield size={17} />
            </div>
            <div>
              <DialogTitle style={{ fontSize: 15, fontWeight: 800 }}>
                Impersonate user
              </DialogTitle>
              <div style={{ fontSize: 11.5, color: 'var(--text-mute)', marginTop: 1 }}>
                Audit-logged on both platform and tenant
              </div>
            </div>
          </div>
          <div
            style={{
              padding: '10px 12px',
              background: 'rgba(248,120,107,.08)',
              border: '1px solid rgba(248,120,107,.28)',
              borderRadius: 8,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-2)',
              lineHeight: 1.55,
            }}
          >
            You're about to log in as <strong style={{ color: '#fff' }}>{targetEmail}</strong>.
            Writes to both <code style={{ fontFamily: 'var(--font-mono)' }}>audit_log_platform</code>{' '}
            and the tenant's <code style={{ fontFamily: 'var(--font-mono)' }}>audit_log</code>.
          </div>
        </DialogHeader>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="label" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>
                Reason for impersonation <span style={{ color: 'var(--coral)' }}>*</span>
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: reason.length < 10 ? 'var(--coral)' : 'var(--text-mute)',
                }}
              >
                {reason.length}/200
              </span>
            </label>
            <textarea
              className="input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 200))}
              placeholder="Investigating reported issue with timesheet submission · CS-2412"
              style={{ resize: 'vertical', padding: 10, fontSize: 12.5, width: '100%' }}
              autoFocus
            />
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: reason.length < 10 ? 'var(--coral)' : 'var(--text-mute)',
                marginTop: 4,
              }}
            >
              Minimum 10 characters required.
            </div>
          </div>

          <div>
            <label className="label">Linked support ticket (optional)</label>
            <input
              className="input"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="CS-2412"
              style={{
                fontFamily: 'var(--font-mono)',
                padding: 10,
                fontSize: 12.5,
                width: '100%',
              }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              gap: 10,
              padding: '10px 12px',
              background: 'var(--surf-1)',
              borderRadius: 8,
              border: '1px solid var(--bord)',
            }}
          >
            <Icon.shield size={14} style={{ color: 'var(--text-mute)', marginTop: 2, flexShrink: 0 }} />
            <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
              Session expires in <strong style={{ color: '#fff' }}>15 minutes</strong>.
              The user will be visible to the customer's admins in their audit log.
              Exit anytime via the banner at the top of the app.
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--bord)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--surf-1)',
          }}
        >
          <Btn kind="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={!valid || isPending}
            icon={<Icon.zap size={13} />}
          >
            {isPending ? 'Starting…' : 'Start impersonation'}
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  )
}
