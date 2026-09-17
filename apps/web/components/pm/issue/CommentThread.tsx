'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Icon } from '@/components/proto'
import { PmAv } from '@/components/pm/projects'
import { toast } from '@/components/ui/use-toast'
import { RichView } from '@/components/pm/editor'
import { AttachmentList } from '@/components/pm/attachments'
import { useAuthStore } from '@/lib/stores/auth.store'
import { useAttachmentsEnabled, useDeletePmFile, useIssueFiles } from '@/lib/api/queries/use-pm-files'
import { fileUrlMap, mergeFiles, type FileUrlMap, type PmFile } from '@/lib/pm/files'

/**
 * A TipTap instance per comment would sit on the item-7 open path (50
 * comments ⇒ 50 ProseMirror views). Bodies render as plain pre-wrap text
 * until they scroll near the viewport (240 px margin, ancestor-clipped), then
 * swap to the markdown view — the visible handful pays, the rest never does.
 */
function LazyRichBody({ value, fileUrls }: { value: string; fileUrls: FileUrlMap }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || visible) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '240px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])
  return (
    <div ref={ref}>
      {visible ? (
        <RichView value={value} fileUrls={fileUrls} />
      ) : (
        <div className="pm-rich pm-rich--view" style={{ whiteSpace: 'pre-wrap' }}>{value}</div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Round L item 6 — the comment list. Rich (flag on): markdown via RichView
// with inline images resolved from `files`; plain (flag off): pre-wrap text,
// unchanged. Chip attachments of each comment sit under its body. "Load
// earlier" appears at the top when the API says there is more (item 7's
// paged detail).
// ─────────────────────────────────────────────────────────

export interface CommentThreadComment {
  id: string
  body: string
  author_user_id: string | null
  parent_comment_id: string | null
  created_at: string
  edited_at?: string | null
}

export interface CommentThreadProps {
  comments: ReadonlyArray<CommentThreadComment>
  /** Every file of the issue (its own + comments') — filtered per comment here. */
  files: ReadonlyArray<PmFile>
  users: ReadonlyArray<{ id: string; name: string; avatar_url?: string | null }>
  hasEarlier?: boolean
  onLoadEarlier?: () => void
  loadingEarlier?: boolean
  /** Needed for the default remove (refreshes the issue's detail + files). */
  issueId?: string
  /** Default: POST pm/files/:id/delete + refresh. */
  onDeleteFile?: (file: PmFile) => void | Promise<void>
  /** Default: uploader is me, or I am Owner/HR Admin. */
  canRemoveFile?: (file: PmFile) => boolean
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function CommentThread({
  comments,
  files,
  users,
  hasEarlier,
  onLoadEarlier,
  loadingEarlier,
  issueId,
  onDeleteFile,
  canRemoveFile,
}: CommentThreadProps) {
  const me = useAuthStore((s) => s.currentUser)
  const { rich } = useAttachmentsEnabled()
  const del = useDeletePmFile()
  // Re-signed every 50 min by the hook (union by id, hook wins) so inline
  // images in an open tab never expire.
  const filesQ = useIssueFiles(issueId, { enabled: rich && !!issueId })
  const allFiles = useMemo(() => mergeFiles(files, filesQ.data?.data), [files, filesQ.data])
  const urls = useMemo(() => fileUrlMap(allFiles), [allFiles])
  const byComment = useMemo(() => {
    const m = new Map<string, PmFile[]>()
    for (const f of allFiles) {
      if (f.object_type !== 'comment' || f.kind !== 'attachment') continue
      const list = m.get(f.object_id) ?? []
      list.push(f)
      m.set(f.object_id, list)
    }
    return m
  }, [allFiles])
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])

  const removeFile = async (f: PmFile) => {
    if (onDeleteFile) return onDeleteFile(f)
    try {
      await del.mutateAsync({ fileId: f.id, issueId })
    } catch (err) {
      toast({ title: 'Couldn’t remove', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    }
  }
  const mayRemove =
    canRemoveFile ??
    ((f: PmFile) => !!me && (f.uploaded_by === me.id || me.role === 'OWNER' || me.role === 'HR_ADMIN'))

  return (
    <>
      {hasEarlier && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 14px', borderBottom: '1px solid var(--bord)' }}>
          <Btn
            kind="ghost"
            size="sm"
            icon={<Icon.chevU size={12} />}
            onClick={onLoadEarlier}
            disabled={loadingEarlier || !onLoadEarlier}
            data-testid="load-earlier"
          >
            {loadingEarlier ? 'Loading…' : 'Load earlier comments'}
          </Btn>
        </div>
      )}
      {comments.map((c) => {
        const author = c.author_user_id ? userById.get(c.author_user_id) : undefined
        const chips = byComment.get(c.id) ?? []
        return (
          <div
            key={c.id}
            data-testid="comment"
            data-comment-id={c.id}
            style={{ display: 'flex', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--bord)', marginLeft: c.parent_comment_id ? 26 : 0 }}
          >
            <PmAv name={author?.name ?? '?'} src={author?.avatar_url} size={22} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 11.5, fontWeight: 800 }}>{author?.name ?? '—'}</span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{when(c.created_at)}</span>
                {c.edited_at && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>· edited</span>}
              </div>
              {rich ? (
                <div style={{ marginTop: 3, fontSize: 13, lineHeight: 1.55 }}>
                  <LazyRichBody value={c.body} fileUrls={urls} />
                </div>
              ) : (
                <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 3 }}>{c.body}</div>
              )}
              {chips.length > 0 && (
                <AttachmentList
                  files={chips}
                  onRemove={removeFile}
                  canRemove={mayRemove}
                  removingId={del.isPending ? del.variables?.fileId : null}
                  style={{ marginTop: 8 }}
                />
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
