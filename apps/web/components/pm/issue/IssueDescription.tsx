'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Btn } from '@/components/proto'
import { Kbd } from '@/components/pm/glyphs'
import { Sk } from '@/components/states'
import { toast } from '@/components/ui/use-toast'
import { RichEditor, RichView } from '@/components/pm/editor'
import { AttachButton, AttachmentList, DropZone, useGlobalDropGuard } from '@/components/pm/attachments'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  invalidateIssueFiles,
  invalidateProjectFiles,
  uploadPmFiles,
  useAttachmentsEnabled,
  useDeletePmFile,
  useIssueFiles,
  useProjectFiles,
} from '@/lib/api/queries/use-pm-files'
import {
  extractFileIds,
  fileUrlMap,
  mergeFiles,
  modKey,
  type FileUrlMap,
  type PmFile,
  type PmFileKind,
} from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — the description card. Rich (flag on): RichView, click to
// edit in RichEditor, paste/drop images inline, Attach chips below. Plain
// (flag off): exactly the textarea / pre-wrap experience the page had, so
// the page can mount this unconditionally.
//
// Inline images pasted while editing upload as DRAFTS (per edit session) and
// travel with Save as `attachmentIds` — the API binds them to the issue; a
// cancelled edit leaves them to the 24 h prune. Chip attachments upload
// straight onto the issue (no Save needed), like Linear.
// ─────────────────────────────────────────────────────────

export interface IssueDescriptionProps {
  /** The id of the object the description belongs to (an issue by default; see `objectType`). */
  issueId: string
  /**
   * Round M — the same card serves a PROJECT's description: files list/upload/
   * remove address `pm/projects/:id/files` and chips filter on object_type
   * 'project'. Default 'issue' — issue behaviour is byte-for-byte unchanged.
   */
  objectType?: 'issue' | 'project'
  /** Empty-state copy shown to editors (default 'Add a description…'). */
  emptyLabel?: string
  /** Round M — optional card heading (the project page shows "Description" so the body can't read as an update). */
  heading?: string
  /** Server markdown ('' when none). */
  value: string
  /** Every file of the issue (its own + comments') — filtered here. */
  files: ReadonlyArray<PmFile>
  canEdit: boolean
  /** Detail still loading and nothing to show yet → skeleton, not "Add a description…". */
  loading?: boolean
  onSave: (markdown: string, attachmentIds: string[]) => void | Promise<void>
  /** Default: uploadPmFiles onto the issue ('attachment') / a per-edit draft ('inline'). `signal` cancels. */
  onUpload?: (
    files: File[],
    kind: PmFileKind,
    onProgress?: (pct: number) => void,
    signal?: AbortSignal,
  ) => Promise<PmFile[]>
  /** Default: POST pm/files/:id/delete + refresh. */
  onDeleteFile?: (file: PmFile) => void | Promise<void>
  /** Default: uploader is me, or I am Owner/HR Admin. */
  canRemoveFile?: (file: PmFile) => boolean
  placeholder?: string
}

export function IssueDescription({
  issueId,
  objectType = 'issue',
  emptyLabel = 'Add a description…',
  heading,
  value,
  files,
  canEdit,
  loading,
  onSave,
  onUpload,
  onDeleteFile,
  canRemoveFile,
  placeholder = 'Describe the task — markdown supported',
}: IssueDescriptionProps) {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.currentUser)
  const { rich, attachments, acceptedExtensions } = useAttachmentsEnabled()
  const del = useDeletePmFile()
  useGlobalDropGuard()
  const mod = modKey()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<Array<{ name: string; size: number }>>([])
  const [localUrls, setLocalUrls] = useState<FileUrlMap>({})
  const inlineIdsRef = useRef<string[]>([])
  const sessionDraftId = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)

  // Keep the draft seeded from the server while not editing.
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  // The detail payload carries `files`; this hook re-signs them every 50 min
  // so an open tab never shows expired images (union by id, hook wins). One
  // of the two is active — the other is a disabled observer.
  const filesQ = useIssueFiles(objectType === 'issue' ? issueId : null, { enabled: rich })
  const projectFilesQ = useProjectFiles(objectType === 'project' ? issueId : null, { enabled: rich })
  const fresh = objectType === 'project' ? projectFilesQ.data?.data : filesQ.data?.data
  const allFiles = useMemo(() => mergeFiles(files, fresh), [files, fresh])
  const urls = useMemo(() => ({ ...fileUrlMap(allFiles), ...localUrls }), [allFiles, localUrls])
  const chips = useMemo(
    () => allFiles.filter((f) => f.object_type === objectType && f.kind === 'attachment'),
    [allFiles, objectType],
  )
  const invalidateFiles = () =>
    objectType === 'project' ? invalidateProjectFiles(qc, issueId) : invalidateIssueFiles(qc, issueId)

  const upload =
    onUpload ??
    (async (picked: File[], kind: PmFileKind, onProgress?: (pct: number) => void, signal?: AbortSignal) => {
      if (kind === 'inline') {
        if (!sessionDraftId.current) sessionDraftId.current = crypto.randomUUID()
        return uploadPmFiles({ objectType: 'draft', objectId: sessionDraftId.current, kind, files: picked, onProgress, signal })
      }
      try {
        return await uploadPmFiles({ objectType, objectId: issueId, kind, files: picked, onProgress, signal })
      } finally {
        invalidateFiles() // a partial batch may have landed
      }
    })

  const cancelUpload = () => abortRef.current?.abort()
  const attach = async (picked: File[]) => {
    const ctl = new AbortController()
    abortRef.current = ctl
    setProgress(0)
    setUploadingFiles(picked.map((f) => ({ name: f.name, size: f.size })))
    try {
      await upload(picked, 'attachment', setProgress, ctl.signal)
    } catch (err) {
      const cancelled = ctl.signal.aborted
      toast({
        title: cancelled ? 'Upload cancelled' : 'Upload failed',
        description: cancelled ? undefined : err instanceof Error ? err.message : 'Try again',
        variant: cancelled ? undefined : 'destructive',
      })
    } finally {
      if (abortRef.current === ctl) abortRef.current = null
      setProgress(null)
      setUploadingFiles([])
    }
  }

  const uploadInline = async (file: File) => {
    const [f] = await upload([file], 'inline')
    if (!f) return null
    inlineIdsRef.current.push(f.id)
    if (f.url) setLocalUrls((m) => ({ ...m, [f.id.toLowerCase()]: f.url! }))
    return { id: f.id, url: f.url }
  }

  const startEdit = () => {
    if (!canEdit) return
    setDraft(value)
    inlineIdsRef.current = []
    sessionDraftId.current = ''
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setDraft(value)
    inlineIdsRef.current = []
  }
  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      // Only images still referenced by the body are bound; an image pasted
      // then removed stays a draft and is pruned (never an invisible row
      // counting against the quota).
      const referenced = new Set(extractFileIds(draft))
      await onSave(draft, inlineIdsRef.current.filter((id) => referenced.has(id.toLowerCase())))
      inlineIdsRef.current = []
      setEditing(false)
    } catch (err) {
      toast({ title: 'Couldn’t save', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const removeFile = async (f: PmFile) => {
    if (onDeleteFile) return onDeleteFile(f)
    try {
      await del.mutateAsync(objectType === 'project' ? { fileId: f.id, projectId: issueId } : { fileId: f.id, issueId })
    } catch (err) {
      toast({ title: 'Couldn’t remove', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    }
  }
  const mayRemove =
    canRemoveFile ??
    ((f: PmFile) => !!me && (f.uploaded_by === me.id || me.role === 'OWNER' || me.role === 'HR_ADMIN'))

  const chipsBlock = (
    <>
      {(chips.length > 0 || uploadingFiles.length > 0) && (
        <AttachmentList
          files={chips}
          uploading={uploadingFiles}
          onRemove={canEdit ? removeFile : undefined}
          canRemove={mayRemove}
          removingId={del.isPending ? del.variables?.fileId : null}
          style={{ marginTop: 10 }}
        />
      )}
      {canEdit && attachments && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: chips.length ? 8 : 10 }}>
          <AttachButton onFiles={attach} progress={progress} onCancel={cancelUpload} acceptedExtensions={acceptedExtensions} />
          <span className="pm-rich-hint">or drop files here{rich ? ' · paste an image into the text' : ''}</span>
        </div>
      )}
    </>
  )

  // ── Plain (flag off) — byte-for-byte the previous UX ──
  if (!rich) {
    return (
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {heading && (
          <div style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--text-2)', letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: 8 }}>{heading}</div>
        )}
        {editing ? (
          <>
            <textarea
              autoFocus
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              style={{ width: '100%', minHeight: 140, resize: 'vertical', fontSize: 13.5, lineHeight: 1.6, padding: 10 }}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save() }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <Btn kind="ghost" size="sm" onClick={cancel}>Cancel</Btn>
              <Btn kind="primary" size="sm" onClick={() => void save()} disabled={saving}>
                Save <Kbd style={{ marginLeft: 5, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>{mod}↵</Kbd>
              </Btn>
            </div>
          </>
        ) : loading && !value ? (
          <div style={{ minHeight: 40, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
            <Sk w="72%" h={10} />
            <Sk w="46%" h={10} />
          </div>
        ) : (
          <div onClick={startEdit} style={{ cursor: canEdit ? 'text' : 'default', minHeight: 40 }}>
            {value ? (
              <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{value}</div>
            ) : (
              <div className="t-mute" style={{ fontSize: 12 }}>{canEdit ? emptyLabel : 'No description'}</div>
            )}
          </div>
        )}
        {chipsBlock}
      </div>
    )
  }

  // ── Rich (flag on) ──
  return (
    <DropZone onFiles={attach} disabled={!canEdit || !attachments} acceptedExtensions={acceptedExtensions}>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {heading && (
          <div style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--text-2)', letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: 8 }}>{heading}</div>
        )}
        {editing ? (
          <>
            <RichEditor
              value={draft}
              onChange={setDraft}
              onSubmit={() => void save()}
              placeholder={placeholder}
              fileUrls={urls}
              onUploadImage={attachments ? uploadInline : undefined}
              minHeight={140}
              autoFocus
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span className="pm-rich-hint">
                {mod}B bold · {mod}I italic · “- ” list · “# ” heading · ``` code
                {attachments ? ' · paste or drop images · select an image and press Backspace to remove it' : ''}
              </span>
              <span style={{ flex: 1 }} />
              <Btn kind="ghost" size="sm" onClick={cancel}>Cancel</Btn>
              <Btn kind="primary" size="sm" onClick={() => void save()} disabled={saving}>
                Save <Kbd style={{ marginLeft: 5, background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff' }}>{mod}↵</Kbd>
              </Btn>
            </div>
          </>
        ) : loading && !value ? (
          <div style={{ minHeight: 40, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
            <Sk w="72%" h={10} />
            <Sk w="46%" h={10} />
          </div>
        ) : (
          <div
            onClick={(e) => {
              // Links and images act on their own; everything else opens the editor.
              if ((e.target as HTMLElement).closest?.('a, img')) return
              startEdit()
            }}
            style={{ cursor: canEdit ? 'text' : 'default', minHeight: 40 }}
            data-testid="issue-description"
          >
            <RichView
              value={value}
              fileUrls={urls}
              empty={<div className="t-mute" style={{ fontSize: 12 }}>{canEdit ? emptyLabel : 'No description'}</div>}
            />
          </div>
        )}
        {chipsBlock}
      </div>
    </DropZone>
  )
}
