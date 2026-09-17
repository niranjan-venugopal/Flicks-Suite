'use client'

import { useState, type CSSProperties, type MouseEvent } from 'react'
import { Icon } from '@/components/proto'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { toast } from '@/components/ui/use-toast'
import { fileIcon, fmtBytes, isImageMime, openPmFile, pmFileUrl, type PmFile } from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — attachment chips. Images render their 480-px thumbnail;
// everything else is icon + name + size. Open/Download never navigate the
// tab to the API origin: the click fetches `GET pm/files/:id/url` through
// the api client (silent refresh, cross-site-cookie safe) and then points a
// pre-opened tab / a transient download anchor at the signed URL; the href
// stays as a middle-click fallback. × confirms before removing (the object
// is gone from storage once removed).
// ─────────────────────────────────────────────────────────

export interface AttachmentListProps {
  files: ReadonlyArray<PmFile>
  onRemove?: (file: PmFile) => void
  canRemove?: (file: PmFile) => boolean
  /** id currently being removed (dims the chip). */
  removingId?: string | null
  /** Ghost chips for files still going up. */
  uploading?: ReadonlyArray<{ name: string; size: number }>
  /** Ask before removing (default true; a not-yet-posted draft chip may skip it). */
  confirmRemove?: boolean
  style?: CSSProperties
}

export function AttachmentList({
  files,
  onRemove,
  canRemove,
  removingId,
  uploading,
  confirmRemove = true,
  style,
}: AttachmentListProps) {
  const [pending, setPending] = useState<PmFile | null>(null)
  if (!files.length && !uploading?.length) return null

  const go = (e: MouseEvent, id: string, download = false) => {
    e.preventDefault()
    e.stopPropagation()
    void openPmFile(id, { download }).catch((err: unknown) =>
      toast({ title: download ? 'Couldn’t download' : 'Couldn’t open', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' }),
    )
  }

  return (
    <div className="pm-attach-list" style={style}>
      {files.map((f) => {
        const removable = !!onRemove && (canRemove ? canRemove(f) : true)
        const busy = removingId === f.id
        const image = isImageMime(f.mime_type)
        const Ic = Icon[fileIcon(f.mime_type, f.file_name)]
        return (
          <div
            key={f.id}
            className={`pm-attach-chip${image ? ' pm-attach-chip--image' : ''}`}
            data-testid="attachment-chip"
            data-file-id={f.id}
            style={{ opacity: busy ? 0.5 : 1 }}
            title={`${f.file_name} · ${fmtBytes(f.size_bytes)}`}
          >
            {image ? (
              <a className="pm-attach-thumb" href={pmFileUrl(f.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => go(e, f.id)}>
                {f.thumb_url || f.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.thumb_url ?? f.url ?? ''} alt={f.file_name} loading="lazy" />
                ) : (
                  <span className="pm-attach-thumb-empty"><Icon.image size={16} /></span>
                )}
              </a>
            ) : (
              <a className="pm-attach-open" href={pmFileUrl(f.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => go(e, f.id)}>
                <Ic size={14} />
              </a>
            )}
            <div className="pm-attach-meta">
              <a className="pm-attach-name" href={pmFileUrl(f.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => go(e, f.id)}>
                {f.file_name}
              </a>
              <span className="pm-attach-size">{fmtBytes(f.size_bytes)}</span>
            </div>
            <a
              className="pm-attach-act"
              href={pmFileUrl(f.id, true)}
              title="Download"
              aria-label={`Download ${f.file_name}`}
              onClick={(e) => go(e, f.id, true)}
            >
              <Icon.download size={13} />
            </a>
            {removable && (
              <button
                type="button"
                className="pm-attach-act pm-attach-x"
                title="Remove"
                aria-label={`Remove ${f.file_name}`}
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (confirmRemove) setPending(f)
                  else onRemove?.(f)
                }}
              >
                <Icon.x size={13} />
              </button>
            )}
          </div>
        )
      })}
      {uploading?.map((u, i) => (
        <div key={`up-${i}-${u.name}`} className="pm-attach-chip pm-attach-chip--uploading" data-testid="attachment-uploading" title={`${u.name} · uploading…`}>
          <span className="pm-attach-open"><Icon.refresh size={13} className="animate-spin" /></span>
          <div className="pm-attach-meta">
            <span className="pm-attach-name">{u.name}</span>
            <span className="pm-attach-size">{fmtBytes(u.size)} · uploading…</span>
          </div>
        </div>
      ))}
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title="Remove attachment"
        body={`Remove “${pending?.file_name ?? ''}”? This cannot be undone.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const f = pending
          setPending(null)
          if (f) onRemove?.(f)
        }}
      />
    </div>
  )
}
