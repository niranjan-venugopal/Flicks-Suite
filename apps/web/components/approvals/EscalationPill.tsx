'use client'

import type { CSSProperties } from 'react'
import type { ApprovalEscalation } from '@/lib/api/queries/use-dashboard'

// ─────────────────────────────────────────────────────────
// Round L — the routing chip on a pending leave / regularization / timesheet
// row. Status, never blame — the reporting manager sees the same chip as the
// person it went to:
//   • level 0, not routed to me  →  muted   "With <manager> · escalates in Nh"
//     (owner/HR admin looking at the workspace-wide Team pages)
//   • level 0, routed to me      →  nothing (it is simply in your queue)
//   • level 1                    →  yellow  "Escalated to <name> · no action for 24h"
//                                   yellow  "Escalated to <name> · manager on leave"
//                                   (+ " · escalates in Nh" when it is not yours)
//   • level 2                    →  yellow  "Escalated to HR · <why>"
//   • level 2, no manager at all →  yellow  "No manager · with HR"
// data-testid="escalation-pill" + data-reason / data-level for the live script.
// ─────────────────────────────────────────────────────────

/** The escalation clock — mirrors ESCALATION_SLA_MS on the API. */
export const ESCALATION_SLA_HOURS = 24

/** Whole hours until the 24 h clock anchored at `anchorIso` runs out (0 = due). */
export function hoursUntilEscalation(anchorIso: string | null | undefined, now = Date.now()): number | null {
  if (!anchorIso) return null
  const t = new Date(anchorIso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.ceil((t + ESCALATION_SLA_HOURS * 3_600_000 - now) / 3_600_000))
}

function countdown(anchorIso: string | null | undefined): string {
  const h = hoursUntilEscalation(anchorIso)
  if (h == null) return ''
  return h === 0 ? ' · escalating soon' : ` · escalates in ${h}h`
}

export function EscalationPill({
  escalation,
  routedToMe = true,
  managerName,
  anchorAt,
  style,
}: {
  escalation?: ApprovalEscalation | null
  /** false = visible to the caller (org-wide Team page) but sitting with someone else. */
  routedToMe?: boolean
  /** The live reporting manager — the "With <manager>" chip. */
  managerName?: string | null
  /** The level-0 clock anchor (appliedAt / requestedAt / submittedAt). */
  anchorAt?: string | null
  style?: CSSProperties
}) {
  const level = escalation?.level ?? 0
  const reason = escalation?.reason ?? null

  if (level === 0) {
    if (routedToMe) return null
    return (
      <span
        className="pill"
        data-testid="escalation-pill"
        data-level="0"
        data-reason="none"
        title="Still with the reporting manager. Escalates one level up after 24 hours without action — you can still act on it here."
        style={{ color: 'var(--text-mute)', ...style }}
      >
        With {managerName?.trim() || 'manager'}{countdown(anchorAt)}
      </span>
    )
  }

  if (reason === 'no_manager') {
    return (
      <span
        className="pill yellow"
        data-testid="escalation-pill"
        data-level={String(level)}
        data-reason="no_manager"
        title="No reporting manager is set — routed straight to Owner / HR Admins."
        style={style}
      >
        No manager · with HR
      </span>
    )
  }

  const why =
    reason === 'reviewer_on_leave'
      ? 'manager on leave'
      : reason === 'no_skip_manager'
        ? 'no one above the manager'
        : 'no action for 24h'
  const to = level >= 2 ? 'HR' : escalation?.toName?.trim() || 'manager'
  const title =
    level >= 2
      ? 'With Owner / HR Admins now. The reporting manager can still act on it.'
      : "With the manager's manager now; escalates to Owner / HR Admins after another 24 hours. The reporting manager can still act on it."

  return (
    <span
      className="pill yellow"
      data-testid="escalation-pill"
      data-level={String(level)}
      data-reason={reason ?? 'sla'}
      title={title}
      style={style}
    >
      Escalated to {to} · {why}{level === 1 && !routedToMe ? countdown(escalation?.at) : ''}
    </span>
  )
}
