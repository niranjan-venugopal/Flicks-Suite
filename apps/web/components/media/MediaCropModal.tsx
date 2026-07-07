'use client'

import { useCallback, useRef, useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area } from 'react-easy-crop'
import { Btn, Icon } from '@/components/proto'

/**
 * D5 — shared avatar/logo crop modal (PRD v4 §4.1). react-easy-crop with a
 * circular mask, zoom slider + drag; states idle (drop zone) → cropping →
 * uploading → success, plus inline errors (type/size/dims are ALSO enforced
 * server-side by magic bytes — these are the fast-path messages).
 */

type CropState = 'idle' | 'cropping' | 'uploading' | 'success' | 'error'

const MAX_BYTES = 8 * 1024 * 1024
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp']

async function cropToBlob(imageSrc: string, area: Area): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Could not read the image'))
    el.src = imageSrc
  })
  const size = Math.min(1024, Math.round(area.width)) // cap upload dimensions
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, size, size)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Crop failed'))),
      'image/webp',
      0.92,
    ),
  )
}

export function MediaCropModal({
  kind,
  onUpload,
  onRemove,
  hasCurrent,
  onClose,
}: {
  kind: 'avatar' | 'logo'
  onUpload: (blob: Blob) => Promise<void>
  onRemove?: () => Promise<void>
  hasCurrent?: boolean
  onClose: () => void
}) {
  const [state, setState] = useState<CropState>('idle')
  const [error, setError] = useState<{ title: string; desc: string } | null>(null)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1.25)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const pick = () => fileInput.current?.click()

  const onFile = (file: File | undefined) => {
    if (!file) return
    if (!ACCEPT.includes(file.type)) {
      setError({
        title: 'That file type isn’t supported',
        desc: 'Upload a JPG, PNG or WebP. SVG files are not accepted.',
      })
      setState('error')
      return
    }
    if (file.size > MAX_BYTES) {
      setError({ title: 'File is too large', desc: 'Maximum size is 8 MB. Try exporting a smaller image.' })
      setState('error')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      const probe = new Image()
      probe.onload = () => {
        if (probe.width < 128 || probe.height < 128) {
          setError({
            title: 'Image is too small',
            desc: 'Photos need to be at least 128 × 128 px for a crisp result.',
          })
          setState('error')
          return
        }
        setImageSrc(src)
        setState('cropping')
      }
      probe.src = src
    }
    reader.readAsDataURL(file)
  }

  const onCropComplete = useCallback((_: Area, areaPixels: Area) => {
    setCroppedArea(areaPixels)
  }, [])

  const save = async () => {
    if (!imageSrc || !croppedArea) return
    setState('uploading')
    try {
      const blob = await cropToBlob(imageSrc, croppedArea)
      await onUpload(blob)
      setState('success')
    } catch (err) {
      setError({
        title: 'Upload failed',
        desc: err instanceof Error ? err.message : 'Please try again.',
      })
      setState('error')
    }
  }

  const remove = async () => {
    if (!onRemove) return
    try {
      await onRemove()
      onClose()
    } catch (err) {
      setError({
        title: 'Could not remove',
        desc: err instanceof Error ? err.message : 'Please try again.',
      })
      setState('error')
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 960,
        background: 'rgba(1,1,13,.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 460,
          background: 'rgba(18,18,30,.98)',
          border: '1px solid var(--bord-2)',
          borderRadius: 16,
          boxShadow: '0 32px 80px rgba(0,0,0,.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
              {kind === 'logo' ? 'Update company logo' : 'Update photo'}
            </div>
            <div className="t-mute" style={{ fontSize: 11 }}>
              JPG, PNG or WebP · max 8 MB · min 128 px{kind === 'logo' ? ' · transparency kept' : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--surf-2)', border: '1px solid var(--bord)', color: 'var(--text-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon.x size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => onFile(e.target.files?.[0])}
          />

          {state === 'idle' && (
            <div
              onClick={pick}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                onFile(e.dataTransfer.files?.[0])
              }}
              style={{
                width: '100%',
                padding: '38px 20px',
                borderRadius: 12,
                border: '1.5px dashed var(--bord-2)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <div style={{ width: 46, height: 46, borderRadius: 12, background: 'rgba(62,123,250,.12)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.camera size={22} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>
                Drag &amp; drop a photo, or <span style={{ color: 'var(--blue)' }}>browse</span>
              </div>
            </div>
          )}

          {state === 'cropping' && imageSrc && (
            <>
              <div style={{ position: 'relative', width: 280, height: 280, borderRadius: 12, overflow: 'hidden', background: '#0A0A14' }}>
                <Cropper
                  image={imageSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  cropShape="round"
                  showGrid={false}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={onCropComplete}
                />
              </div>
              <div style={{ width: 280, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon.image size={13} style={{ color: 'var(--text-faint)' }} />
                <input
                  type="range"
                  min={1}
                  max={2.5}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--blue)' }}
                />
                <Icon.image size={19} style={{ color: 'var(--text-faint)' }} />
              </div>
              <div className="t-caption">Drag to reposition · slider to zoom</div>
            </>
          )}

          {state === 'uploading' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '30px 0' }}>
              <div className="animate-spin" style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--surf-3)', borderTopColor: 'var(--blue)' }} />
              <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-2)' }}>Uploading…</div>
            </div>
          )}

          {state === 'error' && error && (
            <>
              <div style={{ width: '100%', display: 'flex', gap: 11, padding: '13px 15px', borderRadius: 11, background: 'rgba(248,120,107,.08)', border: '1px solid rgba(248,120,107,.3)' }}>
                <Icon.warn size={17} style={{ color: 'var(--coral)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 2 }}>{error.title}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.5 }}>{error.desc}</div>
                </div>
              </div>
              <Btn kind="secondary" size="sm" onClick={() => { setError(null); setState('idle') }}>
                Choose another file
              </Btn>
            </>
          )}

          {state === 'success' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '14px 0', textAlign: 'center' }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', background: 'rgba(39,210,128,.14)', color: 'var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon.check size={22} />
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>
                {kind === 'logo' ? 'Logo updated' : 'Photo updated'}
              </div>
              <div className="t-mute" style={{ fontSize: 11.5 }}>
                Re-encoded to WebP at 256 px + 64 px · EXIF stripped · previous {kind === 'logo' ? 'logo' : 'photo'} deleted
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {hasCurrent && onRemove && state !== 'success' && (
            <button
              onClick={remove}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--coral)', fontSize: 12, fontWeight: 800 }}
            >
              <Icon.trash size={13} /> Remove current {kind === 'logo' ? 'logo' : 'photo'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <Btn kind="ghost" size="sm" onClick={onClose}>
            {state === 'success' ? 'Close' : 'Cancel'}
          </Btn>
          {state === 'cropping' && (
            <Btn kind="primary" size="sm" onClick={save}>
              Save
            </Btn>
          )}
          {state === 'success' && (
            <Btn kind="primary" size="sm" onClick={onClose}>
              Done
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}
