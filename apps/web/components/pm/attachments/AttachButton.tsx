'use client'

import { useRef, type ReactNode } from 'react'
import { Btn, Icon, type BtnKind, type BtnSize } from '@/components/proto'
import { toast } from '@/components/ui/use-toast'
import { acceptFromExtensions, precheckFiles } from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — "Attach" (paperclip) with a hidden multi-file input, an
// inline progress bar and a Cancel while an upload is in flight. Each pick
// is pre-checked per file (type by extension against the server's accepted
// list, 25 MB, non-empty): the good ones go up, the bad ones are named.
// ─────────────────────────────────────────────────────────

export interface AttachButtonProps {
  onFiles: (files: File[]) => void | Promise<void>
  disabled?: boolean
  /** 0–100 while uploading; null/undefined when idle. */
  progress?: number | null
  /** Shown as a Cancel next to the bar while uploading. */
  onCancel?: () => void
  /** Live list from GET pm/uploads/config; defaults to the static mirror. */
  acceptedExtensions?: ReadonlyArray<string>
  label?: ReactNode
  kind?: BtnKind
  size?: BtnSize
  multiple?: boolean
  accept?: string
  title?: string
}

/** Toast naming every rejected file; returns the ones that may go up. */
export function reportPrecheck(picked: File[], acceptedExtensions?: ReadonlyArray<string>): File[] {
  const { ok, rejected } = precheckFiles(picked, acceptedExtensions)
  if (rejected.length) {
    toast({
      title: ok.length ? 'Some files were skipped' : 'Can’t attach that',
      description: rejected.map((r) => `“${r.file.name}” — ${r.reason}`).join(' · '),
      variant: 'destructive',
    })
  }
  return ok
}

export function AttachButton({
  onFiles,
  disabled,
  progress,
  onCancel,
  acceptedExtensions,
  label = 'Attach',
  kind = 'ghost',
  size = 'sm',
  multiple = true,
  accept,
  title = 'Attach files (25 MB each; more than 10 go up in batches)',
}: AttachButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = progress != null
  return (
    <span className="pm-attach-btn" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept ?? acceptFromExtensions(acceptedExtensions)}
        style={{ display: 'none' }}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = '' // same file again should re-trigger
          const ok = reportPrecheck(picked, acceptedExtensions)
          if (ok.length) void onFiles(ok)
        }}
      />
      <Btn
        kind={kind}
        size={size}
        icon={<Icon.paperclip size={13} />}
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        title={title}
        data-testid="attach-button"
      >
        {busy ? `Uploading ${Math.max(0, Math.min(100, progress ?? 0))}%` : label}
      </Btn>
      {busy && onCancel && (
        <Btn kind="ghost" size="sm" onClick={onCancel} title="Cancel upload" data-testid="attach-cancel">
          Cancel
        </Btn>
      )}
      {busy && (
        <span className="pm-attach-progress" aria-hidden>
          <span style={{ width: `${Math.max(2, Math.min(100, progress ?? 0))}%` }} />
        </span>
      )}
    </span>
  )
}
