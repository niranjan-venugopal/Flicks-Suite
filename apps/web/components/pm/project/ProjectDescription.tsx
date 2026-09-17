'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IssueDescription } from '@/components/pm/issue'
import { api } from '@/lib/api/client'
import { bindProjectDrafts, invalidateProjectFiles, useProjectFiles } from '@/lib/api/queries/use-pm-files'
import type { PmSyncEngine } from '@/lib/pm/engine'

// ─────────────────────────────────────────────────────────
// Round M — the project description on the project page (Linear shows it
// under the header). A thin wrapper over the Round L description card:
// RichView / RichEditor, pasted images, attachment chips — with the files
// addressed to `pm/projects/:id/files` (object type 'project').
//
// Save = the description rides `project.update` (engine op or PATCH), THEN
// the pasted images (drafts) are bound with `POST projects/:id/files/bind`.
// The saved markdown stays on screen until the server echoes it or a
// refetch after our ack lands — the same pending rule the issue page uses,
// so a stale refetch already in flight can't revert the text.
// ─────────────────────────────────────────────────────────

export interface ProjectDescriptionProps {
  projectId: string
  engine: PmSyncEngine | null
  /** The REST detail's `project.description_md` ('' when none / not loaded yet). */
  value: string
  /**
   * Any non-guest, non-auditor member — the bar the API's project PATCH
   * enforces (assertNotGuestTx + `pm edit`) and the one the header's fields
   * and the milestones card use. Read-only viewers see nothing when empty.
   */
  canEdit: boolean
  /** Refetches the lazy REST detail (`['pm','project-detail', id]`). */
  invalidate: () => void
}

interface DetailLite {
  data: { project: { description_md: string | null } }
}

export function ProjectDescription({ projectId, engine, value, canEdit, invalidate }: ProjectDescriptionProps) {
  const qc = useQueryClient()
  const filesQ = useProjectFiles(projectId)
  // A second observer of the page's detail query — same key, same cache, one
  // fetch. It gives this card `isLoading` (skeleton, not "Add a description")
  // and `dataUpdatedAt` (has a refetch landed since our write was acked?)
  // without widening the page's props.
  const detailQ = useQuery({
    queryKey: ['pm', 'project-detail', projectId],
    queryFn: () => api.get<DetailLite>(`/api/v1/pm/projects/${projectId}/detail`),
  })

  const [pending, setPending] = useState<{ text: string; at: number } | null>(null)
  const ackedAtRef = useRef(0)
  useEffect(() => {
    if (!pending) return
    const echoed = value.trim() === pending.text.trim()
    const refetchedAfterAck = ackedAtRef.current > pending.at && detailQ.dataUpdatedAt > ackedAtRef.current
    if (echoed || refetchedAfterAck) setPending(null)
  }, [value, detailQ.dataUpdatedAt, pending])
  // Sync mode: our project.update ack marks the moment; the page's own
  // onFlushed handler refetches the detail right after.
  useEffect(() => {
    if (!engine) return
    return engine.onFlushed((acked) => {
      if (acked.some((a) => a.id === projectId && a.op === 'project.update')) ackedAtRef.current = Date.now()
    })
  }, [engine, projectId])

  const save = async (markdown: string, attachmentIds: string[]) => {
    setPending({ text: markdown, at: Date.now() })
    try {
      if (engine) {
        engine.updateProject(projectId, { description_md: markdown })
      } else {
        await api.patch(`/api/v1/pm/projects/${projectId}`, { description_md: markdown })
        ackedAtRef.current = Date.now()
      }
      // Only the images still referenced by the body reach here (the card
      // filters); binding them is its own call because the description
      // itself rides project.update on both transports.
      if (attachmentIds.length) {
        await bindProjectDrafts(projectId, attachmentIds)
        invalidateProjectFiles(qc, projectId)
      }
    } catch (err) {
      setPending(null) // the card toasts; the old text comes back
      throw err
    }
    invalidate()
  }

  const files = filesQ.data?.data ?? []
  const shown = pending?.text ?? value
  // Read-only viewers see nothing when there is nothing to read.
  if (!canEdit && !shown && files.length === 0) return null
  return (
    <div data-testid="project-description">
      <IssueDescription
        objectType="project"
        heading="Description"
        issueId={projectId}
        value={shown}
        files={files}
        canEdit={canEdit}
        loading={detailQ.isLoading}
        onSave={save}
        placeholder="Describe the project — markdown supported"
        emptyLabel="Add a description — markdown supported"
      />
    </div>
  )
}
