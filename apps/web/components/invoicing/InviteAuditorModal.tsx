'use client'

import { useState } from 'react'
import { Btn, Icon, Modal } from '@/components/proto'
import { useInviteAuditor, type InviteAuditorPayload } from '@/lib/api/queries/use-members'
import { useToast } from '@/components/ui/use-toast'

/**
 * Invite-auditor modal (prototype screens-org.jsx InviteAuditorModal, PRD §5.5):
 * email + name, per-module grant checklist (drives the auditor's sidebar),
 * optional access window + note. The grant checks map onto membership_grants
 * rows — invoicing level/capabilities, reports, org_financial.
 */

type GrantKeys = {
  view: boolean
  edit: boolean
  send: boolean
  record: boolean
  customers: boolean
  reports: boolean
  orgView: boolean
  orgEdit: boolean
}

const DEFAULT_GRANTS: GrantKeys = {
  view: true,
  edit: false,
  send: false,
  record: false,
  customers: false,
  reports: true,
  orgView: false,
  orgEdit: false,
}

function toGrantPayload(g: GrantKeys): InviteAuditorPayload['grants'] {
  const grants: NonNullable<InviteAuditorPayload['grants']> = []
  if (g.view || g.edit) {
    grants.push({
      module: 'invoicing',
      access_level: g.edit ? 'edit' : 'view',
      capabilities: {
        ...(g.send ? { send: true } : {}),
        ...(g.record ? { record_payments: true } : {}),
        ...(g.customers ? { manage_customers: true } : {}),
      },
    })
  }
  if (g.reports) grants.push({ module: 'reports', access_level: 'view' })
  if (g.orgView || g.orgEdit) {
    grants.push({ module: 'org_financial', access_level: g.orgEdit ? 'edit' : 'view' })
  }
  return grants
}

export function InviteAuditorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [grants, setGrants] = useState<GrantKeys>(DEFAULT_GRANTS)
  const [expiresAt, setExpiresAt] = useState('')
  const [note, setNote] = useState('')
  const invite = useInviteAuditor()
  const { toast } = useToast()

  const tog = (k: keyof GrantKeys) => setGrants((g) => ({ ...g, [k]: !g[k] }))

  const Check = ({ k, label, sub }: { k: keyof GrantKeys; label: string; sub?: string }) => (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 9,
        cursor: 'pointer',
        background: grants[k] ? 'rgba(62,123,250,.08)' : 'var(--surf-1)',
        border: `1px solid ${grants[k] ? 'rgba(62,123,250,.3)' : 'var(--bord)'}`,
      }}
    >
      <input type="checkbox" checked={grants[k]} onChange={() => tog(k)} style={{ marginTop: 2 }} />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 800 }}>{label}</div>
        {sub && (
          <div className="t-mute" style={{ fontSize: 11, marginTop: 1 }}>
            {sub}
          </div>
        )}
      </div>
    </label>
  )

  const handleSend = async () => {
    if (!email.trim()) {
      toast({ title: 'Email required', variant: 'destructive' })
      return
    }
    try {
      await invite.mutateAsync({
        email: email.trim(),
        full_name: name.trim() || undefined,
        grants: toGrantPayload(grants),
        access_expires_at: expiresAt || undefined,
        note: note.trim() || undefined,
      })
      toast({
        title: 'Invite sent',
        description: `${email.trim()} can accept via the emailed magic link or by switching into this company.`,
      })
      setEmail('')
      setName('')
      setGrants(DEFAULT_GRANTS)
      setExpiresAt('')
      setNote('')
      onClose()
    } catch (err) {
      toast({
        title: 'Could not send invite',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={680}
      title="Invite auditor"
      sub="Settings → Members · finance-scoped, multi-company, non-billable seat"
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            icon={<Icon.send size={15} />}
            onClick={handleSend}
            disabled={invite.isPending}
          >
            {invite.isPending ? 'Sending…' : 'Send invite'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div>
          <div className="label">Email</div>
          <input
            className="input"
            placeholder="ca@firm.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <div className="label">Display name</div>
          <input
            className="input"
            placeholder="Meghna Rao"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div className="label" style={{ marginBottom: 8 }}>
        Granted modules &amp; access <span style={{ color: 'var(--text-faint)' }}>· drives their sidebar</span>
      </div>
      <div style={{ padding: 14, borderRadius: 12, border: '1px solid var(--bord)', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Icon.wallet size={15} style={{ color: 'var(--blue)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 800 }}>Invoicing</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Check k="view" label="View" sub="Default for auditors" />
          <Check k="edit" label="Edit & create" />
          <Check k="send" label="Send" />
          <Check k="record" label="Record payments" />
          <Check k="customers" label="Manage customers" />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ padding: 14, borderRadius: 12, border: '1px solid var(--bord)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 10 }}>Reports</div>
          <Check k="reports" label="Reports & GSTR-1/TDS export" sub="On by default" />
        </div>
        <div style={{ padding: 14, borderRadius: 12, border: '1px solid var(--bord)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 10 }}>
            Org → Financial details
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Check k="orgView" label="View bank / GSTIN / PAN" />
            <Check k="orgEdit" label="Edit" />
          </div>
        </div>
      </div>
      <div
        style={{
          padding: 14,
          borderRadius: 12,
          border: '1px dashed var(--bord-2)',
          opacity: 0.6,
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon.wallet size={15} style={{ color: 'var(--text-faint)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-mute)' }}>Payroll</span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--text-faint)',
            }}
          >
            Available when Payroll launches
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div className="label">
            Access window <span style={{ color: 'var(--text-faint)' }}>· optional</span>
          </div>
          <input
            className="input"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        <div>
          <div className="label">
            Note <span style={{ color: 'var(--text-faint)' }}>· optional</span>
          </div>
          <input
            className="input"
            placeholder="FY25-26 audit engagement"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  )
}
