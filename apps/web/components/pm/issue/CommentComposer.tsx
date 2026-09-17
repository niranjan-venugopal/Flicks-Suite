'use client'

import { useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Btn } from '@/components/proto'
import { PmAv } from '@/components/pm/projects'
import { toast } from '@/components/ui/use-toast'
import { RichEditor, type RichEditorHandle } from '@/components/pm/editor'
import { AttachButton, AttachmentList, DropZone, useGlobalDropGuard } from '@/components/pm/attachments'
import { useAuthStore } from '@/lib/stores/auth.store'
import { uploadPmFiles, useAttachmentsEnabled } from '@/lib/api/queries/use-pm-files'
import { extractFileIds, modKey, type FileUrlMap, type PmFile, type PmFileKind } from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — the comment composer. Rich (flag on): RichEditor with
// Attach chips, drag-drop and inline image paste; every upload is a DRAFT
// keyed by `draftId` and submitted as `attachmentIds` so the API binds them
// to the new comment. Plain (flag off): the original single-line input.
// Both keep the @-mention dropdown (ported from issues/[id]/page.tsx): type
// "@" + a name, ↑/↓ to move, ↵ to pick, Esc to dismiss; on submit only
// mentions still present in the text are sent.
// ─────────────────────────────────────────────────────────

export interface CommentComposerUser {
  id: string
  name: string
  avatar_url?: string | null
}

export interface CommentComposerProps {
  issueId: string
  /** Per-open uuid; the object_id of draft uploads (regenerate after a post if you like). */
  draftId: string
  users: ReadonlyArray<CommentComposerUser>
  /** Resolve = posted (composer clears); reject = keep everything and show the error. */
  onSubmit: (markdown: string, attachmentIds: string[], mentionedUserIds: string[]) => void | Promise<void>
  /** Default: uploadPmFiles({ objectType: 'draft', objectId: draftId, kind }). `signal` cancels. */
  onUpload?: (
    files: File[],
    kind: PmFileKind,
    onProgress?: (pct: number) => void,
    signal?: AbortSignal,
  ) => Promise<PmFile[]>
  /** Submit in flight (disables the button). */
  pending?: boolean
  /** Default: "Leave a comment… @ to mention (⌘↵ to send)" with the platform's modifier. */
  placeholder?: string
  /** Not offered in the mention list (default: the signed-in user). */
  excludeUserId?: string
  autoFocus?: boolean
}

const MENTION_RE = /@([\w .-]*)$/

export function CommentComposer({
  issueId: _issueId,
  draftId,
  users,
  onSubmit,
  onUpload,
  pending,
  placeholder: placeholderProp,
  excludeUserId,
  autoFocus,
}: CommentComposerProps) {
  const me = useAuthStore((s) => s.currentUser)
  const { rich, attachments, acceptedExtensions } = useAttachmentsEnabled()
  const handleRef = useRef<RichEditorHandle | null>(null)
  useGlobalDropGuard()
  const mod = modKey()
  const placeholder = placeholderProp ?? `Leave a comment… @ to mention (${mod}↵ to send)`

  const [text, setText] = useState('')
  const [cursorText, setCursorText] = useState('')
  const [mentioned, setMentioned] = useState<Array<{ id: string; name: string }>>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const [pendingFiles, setPendingFiles] = useState<PmFile[]>([])
  const [uploadingFiles, setUploadingFiles] = useState<Array<{ name: string; size: number }>>([])
  const [localUrls, setLocalUrls] = useState<FileUrlMap>({})
  const inlineIdsRef = useRef<string[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const exclude = excludeUserId ?? me?.id

  // ── @-mention dropdown state (derived from the text before the cursor) ──
  const probe = rich ? cursorText : text
  const mentionMatch = probe.match(MENTION_RE)
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? null
  const mentionOptions = useMemo(
    () =>
      mentionQuery !== null
        ? users.filter((u) => u.id !== exclude && u.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
        : [],
    [users, exclude, mentionQuery],
  )
  const pickMention = (u: { id: string; name: string }) => {
    if (rich) {
      handleRef.current?.replaceTextBeforeCursor(MENTION_RE, `@${u.name} `)
      setCursorText('')
    } else {
      setText(text.replace(MENTION_RE, `@${u.name} `))
    }
    setMentioned((prev) => (prev.some((m) => m.id === u.id) ? prev : [...prev, { id: u.id, name: u.name }]))
    setMentionIdx(0)
  }
  const dismissMention = () => {
    if (rich) {
      handleRef.current?.replaceTextBeforeCursor(MENTION_RE, '')
      setCursorText('')
    } else {
      setText(text.replace(MENTION_RE, ''))
    }
  }
  // Shared ↑/↓/↵/Esc handling — returns true when the key was consumed.
  const mentionKey = (key: string, meta: boolean): boolean => {
    if (!mentionOptions.length) return false
    if (key === 'ArrowDown') { setMentionIdx((i) => (i + 1) % mentionOptions.length); return true }
    if (key === 'ArrowUp') { setMentionIdx((i) => (i - 1 + mentionOptions.length) % mentionOptions.length); return true }
    if (key === 'Enter' && !meta) { pickMention(mentionOptions[mentionIdx] ?? mentionOptions[0]!); return true }
    if (key === 'Escape') { dismissMention(); return true }
    return false
  }

  // ── uploads (drafts) ──
  const upload =
    onUpload ??
    ((files: File[], kind: PmFileKind, onProgress?: (pct: number) => void, signal?: AbortSignal) =>
      uploadPmFiles({ objectType: 'draft', objectId: draftId, kind, files, onProgress, signal }))

  const cancelUpload = () => abortRef.current?.abort()
  const attach = async (files: File[]) => {
    const ctl = new AbortController()
    abortRef.current = ctl
    setProgress(0)
    setUploadingFiles(files.map((f) => ({ name: f.name, size: f.size })))
    try {
      const out = await upload(files, 'attachment', setProgress, ctl.signal)
      setPendingFiles((prev) => [...prev, ...out])
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
  const dropPending = (f: PmFile) => setPendingFiles((prev) => prev.filter((p) => p.id !== f.id))

  // ── submit ──
  const busy = !!pending || submitting
  const body = text.trim()
  // A files-only comment is a real comment (the API accepts an empty body
  // with attachment_ids) — never a dead end.
  const canSend = (!!body || pendingFiles.length > 0) && !busy
  const submit = async () => {
    if (!canSend) return
    const ids = [...new Set(mentioned.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id))]
    // Chips always bind; inline images only while the body still references
    // them — a pasted-then-deleted image stays a draft and is pruned.
    const referenced = new Set(extractFileIds(body))
    const attachmentIds = [
      ...pendingFiles.map((f) => f.id),
      ...inlineIdsRef.current.filter((id) => referenced.has(id.toLowerCase())),
    ]
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(body, attachmentIds, ids)
      setText('')
      setCursorText('')
      setMentioned([])
      setPendingFiles([])
      inlineIdsRef.current = []
      handleRef.current?.clear()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t post the comment')
    } finally {
      setSubmitting(false)
    }
  }

  const dropdown = mentionOptions.length > 0 && (
    <div
      style={{
        position: 'absolute',
        bottom: 'calc(100% - 4px)',
        left: 12,
        width: 240,
        zIndex: 60,
        background: 'rgba(18,18,30,.98)',
        border: '1px solid var(--bord-2)',
        borderRadius: 10,
        padding: 4,
        boxShadow: '0 16px 40px rgba(0,0,0,.55)',
      }}
      data-testid="mention-menu"
    >
      {mentionOptions.map((u, i) => (
        <button
          key={u.id}
          type="button"
          onMouseDown={(e) => { e.preventDefault(); pickMention(u) }}
          onMouseEnter={() => setMentionIdx(i)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            background: i === mentionIdx ? 'var(--surf-2)' : 'transparent',
            color: '#fff',
          }}
        >
          <PmAv name={u.name} src={u.avatar_url} size={18} />
          <span style={{ fontSize: 12, fontWeight: 700 }}>{u.name}</span>
        </button>
      ))}
    </div>
  )

  // ── Plain (flag off) — the original input row ──
  if (!rich) {
    return (
      <div style={{ display: 'flex', gap: 9, padding: 12, position: 'relative' }} data-testid="comment-composer">
        {dropdown}
        <input
          className="input"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => { setText(e.target.value); setMentionIdx(0) }}
          onKeyDown={(e) => {
            if (mentionKey(e.key, e.metaKey || e.ctrlKey)) { e.preventDefault(); return }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
          }}
          placeholder={placeholder}
          style={{ flex: 1, height: 36 }}
        />
        <Btn kind="secondary" size="sm" disabled={!canSend} onClick={() => void submit()} data-testid="comment-submit">
          Comment
        </Btn>
      </div>
    )
  }

  // ── Rich (flag on) ──
  return (
    <DropZone onFiles={attach} disabled={!attachments} label="Drop files to attach to your comment" acceptedExtensions={acceptedExtensions}>
      <div style={{ padding: 12, position: 'relative' }} data-testid="comment-composer">
        {dropdown}
        <RichEditor
          value={text}
          onChange={(md) => { setText(md); setMentionIdx(0) }}
          onSubmit={() => void submit()}
          onCursorText={setCursorText}
          onKeyDown={(e: KeyboardEvent, _editor: Editor) => {
            if (mentionKey(e.key, e.metaKey || e.ctrlKey)) { e.preventDefault(); return true }
            return false
          }}
          placeholder={placeholder}
          fileUrls={localUrls}
          onUploadImage={attachments ? uploadInline : undefined}
          minHeight={44}
          autoFocus={autoFocus}
          handleRef={handleRef}
          compact
        />
        {(pendingFiles.length > 0 || uploadingFiles.length > 0) && (
          <AttachmentList files={pendingFiles} uploading={uploadingFiles} onRemove={dropPending} confirmRemove={false} style={{ marginTop: 8 }} />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          {attachments && (
            <AttachButton onFiles={attach} progress={progress} onCancel={cancelUpload} acceptedExtensions={acceptedExtensions} />
          )}
          <span className="pm-rich-hint">
            {error ? (
              <span style={{ color: 'var(--coral)' }}>{error}</span>
            ) : attachments ? (
              `Drop files or paste images · ${mod}↵ to send`
            ) : (
              `${mod}↵ to send`
            )}
          </span>
          <span style={{ flex: 1 }} />
          <Btn
            kind="secondary"
            size="sm"
            disabled={!canSend}
            onClick={() => void submit()}
            data-testid="comment-submit"
            title={!body && pendingFiles.length ? 'Post the attached files' : undefined}
          >
            {busy ? 'Posting…' : 'Comment'}
          </Btn>
        </div>
      </div>
    </DropZone>
  )
}
