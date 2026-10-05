'use client'

import { useEffect, useRef, useState } from 'react'
import { Btn, Icon } from '@/components/proto'
import { AssetThumb } from './AssetThumb'

/**
 * Round P R4 — the asset photo picker used by the Add / Edit form.
 *
 * MediaCropModal is built for people and logos (circular mask, "Update
 * photo" / "Update company logo" copy), which reads wrong for a laptop or a
 * SIM card, so this is its own small picker: file input (JPG / PNG / WebP),
 * the same 8 MB + 128 px guards the server enforces, a square preview, and
 * Replace / Remove. Nothing uploads from here — the parent holds the picked
 * Blob and sends it after the create / update has returned (the asset id
 * only exists then), so the form never ships a dead button when the API is
 * briefly unavailable.
 *
 * Large photos (phone cameras) are downscaled client-side to ≤ 1600 px on the
 * long side before upload; the server re-encodes to 256 + 64 px anyway, so a
 * 6 MB original would only make the upload slow.
 */

const MAX_BYTES = 8 * 1024 * 1024
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp']
const MAX_EDGE = 1600

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Could not read the image'))
    el.src = src
  })
}

async function downscale(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const edge = Math.max(img.width, img.height)
    if (edge <= MAX_EDGE) return file
    const scale = MAX_EDGE / edge
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b ?? file), 'image/webp', 0.9),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function AssetPhotoField({
  currentUrl,
  pending,
  category,
  onPick,
  onClear,
  disabled,
}: {
  /** The asset's existing photo (edit), or null. */
  currentUrl: string | null
  /** A photo picked in this form session, not uploaded yet. */
  pending: Blob | null
  category?: string | null
  onPick: (blob: Blob) => void
  /** Drops the pending pick, or (when there is no pick) marks the current photo for removal. */
  onClear: () => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!pending) {
      setPendingUrl(null)
      return
    }
    const url = URL.createObjectURL(pending)
    setPendingUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pending])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    // Camera captures and some Android file managers report no MIME type at
    // all — let those through to the decode probe below (and the server's
    // magic-byte check); only an explicitly wrong type is refused here.
    if (file.type && !ACCEPT.includes(file.type)) {
      setError('Upload a JPG, PNG or WebP photo.')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('That file is over 8 MB — export a smaller photo and try again.')
      return
    }
    setBusy(true)
    try {
      const probeUrl = URL.createObjectURL(file)
      try {
        const img = await loadImage(probeUrl)
        if (img.width < 128 || img.height < 128) {
          setError('Photos need to be at least 128 × 128 px.')
          return
        }
      } finally {
        URL.revokeObjectURL(probeUrl)
      }
      onPick(await downscale(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const preview = pendingUrl ?? currentUrl
  const hasSomething = !!preview

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e.target.files?.[0])}
        data-testid="asset-photo-input"
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {preview ? (
          <AssetThumb src={preview} category={category} size={84} radius={12} />
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={disabled || busy}
            style={{
              width: 84,
              height: 84,
              borderRadius: 12,
              border: '1.5px dashed var(--bord-2)',
              background: 'transparent',
              color: 'var(--text-faint)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: disabled ? 'default' : 'pointer',
              flexShrink: 0,
            }}
            aria-label="Add a photo"
          >
            <Icon.camera size={22} />
          </button>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Btn
              kind="secondary"
              size="sm"
              icon={<Icon.camera size={12} />}
              onClick={() => input.current?.click()}
              disabled={disabled || busy}
            >
              {busy ? 'Reading…' : hasSomething ? 'Replace photo' : 'Add photo'}
            </Btn>
            {hasSomething && (
              <Btn kind="ghost" size="sm" icon={<Icon.trash size={12} />} onClick={onClear} disabled={disabled || busy}>
                {pending ? 'Discard' : 'Remove'}
              </Btn>
            )}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: error ? 'var(--coral)' : 'var(--text-mute)', lineHeight: 1.45 }}>
            {error ??
              (pending
                ? 'Uploads when you save.'
                : 'JPG, PNG or WebP · max 8 MB. A photo of the actual unit helps at handover and return.')}
          </div>
        </div>
      </div>
    </div>
  )
}
