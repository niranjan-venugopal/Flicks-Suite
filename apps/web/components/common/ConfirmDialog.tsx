'use client'

import type { ReactNode } from 'react'
import { Btn, Icon, Modal } from '@/components/proto'

interface ConfirmDialogProps {
  open: boolean
  /** Cancel button, X and backdrop — the caller clears its pending state here. */
  onClose: () => void
  /** Short imperative, e.g. "Delete form". */
  title: string
  /** The confirmation copy — carries the exact message the action needs. */
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** true → coral danger confirm (destructive); false → primary confirm. */
  danger?: boolean
  /** Disables both buttons and blocks dismissal while the mutation runs. */
  loading?: boolean
  loadingLabel?: string
  /** Fires the mutation. The CALLER closes on success (or navigates away). */
  onConfirm: () => void
}

/**
 * House replacement for window.confirm() — a proto Modal with the standard
 * ghost-Cancel / danger-or-primary-confirm footer (same shape as the CRM
 * "Mark as lost" dialog). Controlled: callers keep a pending-row state and
 * wire loading={mutation.isPending}.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  loading,
  loadingLabel = 'Working…',
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      // A backdrop click mid-mutation would strand the in-flight work with
      // no dialog — dismissal is blocked while loading.
      onClose={loading ? () => {} : onClose}
      width={440}
      title={title}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Btn>
          <Btn
            kind={danger ? 'danger' : 'primary'}
            icon={danger ? <Icon.trash size={14} /> : <Icon.check size={14} />}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? loadingLabel : confirmLabel}
          </Btn>
        </>
      }
    >
      {body && (
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text-2)',
            lineHeight: 1.55,
          }}
        >
          {body}
        </div>
      )}
    </Modal>
  )
}
