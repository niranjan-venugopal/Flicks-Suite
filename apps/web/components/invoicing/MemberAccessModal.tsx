'use client'

import { useState } from 'react'
import { Btn, Modal, Toggle } from '@/components/proto'
import { useUpdateGrants, type InviteAuditorPayload } from '@/lib/api/queries/use-members'
import { useToast } from '@/components/ui/use-toast'

/**
 * Owner-facing "Manage invoicing access" for a standard member (Manager/
 * Employee). Invoicing access for these roles is opt-in via membership_grants
 * — the same mechanism as auditors (PRD §3). Owner/Admin/Finance have full
 * access by role and never need this. Persists via PATCH /settings/members/:id/grants.
 */

interface Grant {
  module: string
  access_level: string
  capabilities: Record<string, boolean>
}

type Level = 'none' | 'view' | 'edit'

export function MemberAccessModal({
  open,
  onClose,
  membershipId,
  memberName,
  currentGrants,
}: {
  open: boolean
  onClose: () => void
  membershipId: string
  memberName: string
  currentGrants: Grant[]
}) {
  const invoicing = currentGrants.find((g) => g.module === 'invoicing')
  const reports = currentGrants.find((g) => g.module === 'reports')
  const initialCaps = invoicing?.capabilities ?? {}

  const [level, setLevel] = useState<Level>((invoicing?.access_level as Level) ?? 'none')
  const [send, setSend] = useState(!!initialCaps.send)
  const [record, setRecord] = useState(!!initialCaps.record_payment)
  const [customers, setCustomers] = useState(!!initialCaps.manage_customers)
  const [reportsOn, setReportsOn] = useState(!!reports && reports.access_level !== 'none')

  const update = useUpdateGrants()
  const { toast } = useToast()

  const save = async () => {
    const grants: NonNullable<InviteAuditorPayload['grants']> = []
    if (level !== 'none') {
      grants.push({
        module: 'invoicing',
        access_level: level,
        capabilities: {
          ...(send ? { send: true } : {}),
          ...(record ? { record_payment: true } : {}),
          ...(customers ? { manage_customers: true } : {}),
        },
      })
    }
    if (reportsOn) grants.push({ module: 'reports', access_level: 'view' })
    try {
      await update.mutateAsync({ membershipId, grants })
      toast({ title: 'Access updated', description: `${memberName}'s invoicing access saved.` })
      onClose()
    } catch (err) {
      toast({
        title: 'Could not update access',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  const levelBtn = (val: Level, label: string) => (
    <button
      type="button"
      onClick={() => setLevel(val)}
      style={{
        flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 800,
        background: level === val ? 'var(--surf-3)' : 'var(--surf-1)',
        color: level === val ? '#fff' : 'var(--text-2)',
        border: `1px solid ${level === val ? 'var(--bord-2)' : 'var(--bord)'}`,
      }}
    >
      {label}
    </button>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title="Invoicing access"
      sub={`Grant ${memberName} access to the Invoicing module`}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save access'}
          </Btn>
        </>
      }
    >
      <div className="label" style={{ marginBottom: 8 }}>Invoicing access level</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {levelBtn('none', 'No access')}
        {levelBtn('view', 'View')}
        {levelBtn('edit', 'Edit & create')}
      </div>

      {level !== 'none' && (
        <>
          <div className="label" style={{ marginBottom: 8 }}>Capabilities</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            <CapRow label="Send invoices" on={send} onChange={setSend} />
            <CapRow label="Record payments" on={record} onChange={setRecord} />
            <CapRow label="Manage customers" on={customers} onChange={setCustomers} />
          </div>
        </>
      )}

      <div className="label" style={{ marginBottom: 8 }}>Reports</div>
      <CapRow label="View reports & GSTR-1 / TDS" on={reportsOn} onChange={setReportsOn} />
    </Modal>
  )
}

function CapRow({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', borderRadius: 9, background: 'var(--surf-1)', border: '1px solid var(--bord)',
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
      <Toggle on={on} onChange={onChange} />
    </div>
  )
}
