'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/components/proto'
import { reportPrecheck } from './AttachButton'

/**
 * Page-level guard: a file dropped OUTSIDE a DropZone/editor would navigate
 * the tab to the file. Mount once per page (IssueDescription does, so every
 * issue page gets it); handled drops are unaffected — their handlers run
 * first and this only cancels the default for the rest.
 */
export function useGlobalDropGuard(): void {
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])
}

// ─────────────────────────────────────────────────────────
// Round L item 6 — drag-and-drop surface. Wraps its children; when files
// are dragged over it a dashed overlay appears (crm/import precedent), and a
// drop hands the files to `onFiles`. Image drops that land INSIDE the rich
// editor are claimed there (stopPropagation) so they become inline images
// and are not attached twice; the capture-phase reset keeps the overlay
// honest in that case, since no `drop` reaches us.
// ─────────────────────────────────────────────────────────

export interface DropZoneProps {
  onFiles: (files: File[]) => void | Promise<void>
  disabled?: boolean
  label?: ReactNode
  /** Live list from GET pm/uploads/config; defaults to the static mirror. */
  acceptedExtensions?: ReadonlyArray<string>
  children: ReactNode
  className?: string
  style?: CSSProperties
}

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export function DropZone({
  onFiles,
  disabled,
  label = 'Drop files to attach',
  acceptedExtensions,
  children,
  className = '',
  style,
}: DropZoneProps) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  // A drag that ends elsewhere (or a drop the editor consumed) never sends
  // us dragleave — reset on the document-level dragend/drop.
  useEffect(() => {
    if (disabled) return
    const reset = () => {
      depth.current = 0
      setOver(false)
    }
    document.addEventListener('dragend', reset)
    document.addEventListener('drop', reset, true)
    return () => {
      document.removeEventListener('dragend', reset)
      document.removeEventListener('drop', reset, true)
    }
  }, [disabled])

  if (disabled) return <>{children}</>

  return (
    <div
      className={`pm-dropzone${className ? ` ${className}` : ''}`}
      style={{ position: 'relative', ...style }}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDropCapture={() => {
        depth.current = 0
        setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        const picked = Array.from(e.dataTransfer.files ?? [])
        const ok = reportPrecheck(picked, acceptedExtensions)
        if (ok.length) void onFiles(ok)
      }}
    >
      {children}
      {over && (
        <div className="pm-drop-overlay" aria-hidden>
          <Icon.upload size={18} />
          <span>{label}</span>
        </div>
      )}
    </div>
  )
}
