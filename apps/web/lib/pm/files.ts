import type { IconKey } from '@/components/proto'
import { api } from '@/lib/api/client'

// ─────────────────────────────────────────────────────────
// Round L item 6 — attachment helpers shared by the editor, the chips and
// the issue components. Bodies are stored as markdown with inline images as
// `![name](flicks-file://<record_file_id>)`; a signed URL is never stored.
// The editor keeps the flicks-file:// src in its document and resolves it to
// a signed URL at render time (see components/pm/editor/extensions.ts), so
// `toDisplayMarkdown` / `toStorageMarkdown` are only needed where a plain
// markdown string must carry real URLs (copy/export) or be normalised back.
// ─────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

export const FLICKS_FILE_PREFIX = 'flicks-file://'
export const PM_FILE_MAX_BYTES = 25 * 1024 * 1024
export const PM_FILES_PER_REQUEST = 10
/** Mirror of the API's PM_ACCEPTED_EXTENSIONS (GET pm/uploads/config carries the live list). */
export const PM_ACCEPTED_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'zip',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md', 'json',
] as const
/** Explicit types only — no `image/*` (it offered HEIC/BMP/SVG the server then refused). */
export function acceptFromExtensions(exts: ReadonlyArray<string> = PM_ACCEPTED_EXTENSIONS): string {
  const dots = exts.map((e) => `.${e.toLowerCase()}`)
  return [...dots, 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].join(',')
}
export const PM_ACCEPT = acceptFromExtensions()

/** Union by id; a later list wins (fresher signed URLs). */
export function mergeFiles(
  base: ReadonlyArray<PmFile> | null | undefined,
  fresh: ReadonlyArray<PmFile> | null | undefined,
): PmFile[] {
  if (!fresh?.length) return [...(base ?? [])]
  const byId = new Map<string, PmFile>()
  for (const f of base ?? []) byId.set(f.id, f)
  for (const f of fresh) byId.set(f.id, f)
  return [...byId.values()]
}

export function chunk<T>(list: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere (SSR-safe). */
export function modKey(): string {
  if (typeof navigator === 'undefined') return '⌘'
  return /mac|iphone|ipad|ipod/i.test(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`) ? '⌘' : 'Ctrl'
}

export type PmFileObjectType = 'issue' | 'comment' | 'draft'
export type PmFileKind = 'attachment' | 'inline'

/** Mirror of the API's PmFile (files.service.ts). */
export interface PmFile {
  id: string
  object_type: string
  object_id: string
  kind: string
  file_name: string
  mime_type: string
  size_bytes: number
  width: number | null
  height: number | null
  url: string | null
  thumb_url: string | null
  uploaded_by: string | null
  created_at: string
}

/** id → signed url (lowercase ids, so lookups are exact). */
export type FileUrlMap = Record<string, string>

export function fileUrlMap(files: ReadonlyArray<PmFile> | null | undefined): FileUrlMap {
  const out: FileUrlMap = {}
  for (const f of files ?? []) if (f.url) out[f.id.toLowerCase()] = f.url
  return out
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `flicks-file://<id>` → id (lowercase) or null. */
export function fileIdFromSrc(src: string | null | undefined): string | null {
  if (!src) return null
  const s = src.trim()
  if (!s.toLowerCase().startsWith(FLICKS_FILE_PREFIX)) return null
  const id = s.slice(FLICKS_FILE_PREFIX.length).toLowerCase()
  return UUID_RE.test(id) ? id : null
}

export function fileSrc(id: string): string {
  return `${FLICKS_FILE_PREFIX}${id.toLowerCase()}`
}

/** The record_files ids a body references (lowercase, deduped). */
export function extractFileIds(markdown: string | null | undefined): string[] {
  if (!markdown) return []
  const ids = new Set<string>()
  const re = new RegExp(`${FLICKS_FILE_PREFIX}([0-9a-f-]{36})`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const id = m[1]!.toLowerCase()
    if (UUID_RE.test(id)) ids.add(id)
  }
  return [...ids]
}

/** Storage markdown → display markdown: flicks-file:// targets become their signed URLs (unknown ids are left as-is). */
export function toDisplayMarkdown(markdown: string, urls: FileUrlMap): string {
  if (!markdown) return ''
  return markdown.replace(new RegExp(`${FLICKS_FILE_PREFIX}([0-9a-f-]{36})`, 'gi'), (whole, id: string) => {
    const url = urls[id.toLowerCase()]
    return url ?? whole
  })
}

/** Display markdown → storage markdown: any known signed URL becomes flicks-file://<id>. */
export function toStorageMarkdown(markdown: string, urls: FileUrlMap): string {
  if (!markdown) return ''
  let out = markdown
  for (const [id, url] of Object.entries(urls)) {
    if (!url) continue
    out = out.split(url).join(fileSrc(id))
    // A signed URL may have been re-signed since — match on the key path too.
    const path = url.split('?')[0]
    if (path && path !== url) out = out.split(path).join(fileSrc(id))
  }
  return out
}

export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime && mime.startsWith('image/')
}

/** Proto icon for a file chip. */
export function fileIcon(mime: string | null | undefined, name?: string | null): IconKey {
  const m = (mime ?? '').toLowerCase()
  const ext = (name ?? '').toLowerCase().split('.').pop() ?? ''
  if (m.startsWith('image/')) return 'image'
  if (m === 'application/pdf' || ext === 'pdf') return 'doc'
  if (m.includes('spreadsheet') || m === 'text/csv' || ['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet'
  if (m.includes('presentation') || ['ppt', 'pptx'].includes(ext)) return 'layers'
  if (m.includes('word') || ['doc', 'docx'].includes(ext)) return 'doc'
  if (m === 'application/zip' || ext === 'zip') return 'briefcase'
  if (m.startsWith('text/') || m === 'application/json' || ['txt', 'md', 'json'].includes(ext)) return 'clipboard'
  return 'file'
}

export function fmtBytes(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(v < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** The cookie-authed open/download route (302 → 15-minute signed URL). Kept as the anchor href for middle-click; clicks go through openPmFile. */
export function pmFileUrl(id: string, dl = false): string {
  return `${BASE_URL}/api/v1/pm/files/${encodeURIComponent(id)}${dl ? '?dl=1' : ''}`
}

/** The JSON variant `GET pm/files/:id/url` (api-relative) — rides the api client's silent refresh. */
export function pmFileUrlPath(id: string, dl = false): string {
  return `/api/v1/pm/files/${encodeURIComponent(id)}/url${dl ? '?dl=1' : ''}`
}

/**
 * Open (new tab) or download a file without a cookie-authed top-level
 * navigation to the API origin — a cross-site API host with SameSite=strict
 * cookies, or an access cookie that lapsed while the tab slept, would turn
 * that into a raw 401 page. The tab is opened synchronously (inside the
 * click, so popup blockers allow it) and pointed at the signed URL once it
 * arrives through the api client; downloads click a transient anchor whose
 * target carries Content-Disposition: attachment, so the page stays put.
 */
export async function openPmFile(id: string, opts: { download?: boolean } = {}): Promise<void> {
  const download = !!opts.download
  const tab = download ? null : window.open('', '_blank')
  if (tab) tab.opener = null
  try {
    const res = await api.get<{ data: { url: string } }>(pmFileUrlPath(id, download))
    const url = res.data.url
    if (download) {
      const a = document.createElement('a')
      a.href = url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } else if (tab) {
      tab.location.href = url
    } else {
      window.open(url, '_blank', 'noopener')
    }
  } catch (err) {
    tab?.close()
    throw err
  }
}

export interface PrecheckResult {
  ok: File[]
  /** One line naming every rejected file, or null. */
  error: string | null
  rejected: Array<{ file: File; reason: string }>
}

/**
 * Client-side pre-checks so an obviously bad pick fails before the round
 * trip — per file, so the good ones still go up and the bad ones are named.
 * More than 10 files is fine: uploadPmFiles sends them in batches.
 */
export function precheckFiles(
  files: File[],
  acceptedExts: ReadonlyArray<string> = PM_ACCEPTED_EXTENSIONS,
): PrecheckResult {
  const accept = new Set(acceptedExts.map((e) => e.toLowerCase()))
  const ok: File[] = []
  const rejected: Array<{ file: File; reason: string }> = []
  for (const f of files) {
    const dot = f.name.lastIndexOf('.')
    const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : ''
    if (!ext || !accept.has(ext)) rejected.push({ file: f, reason: `${ext ? `.${ext}` : 'that kind of'} file isn’t supported` })
    else if (f.size > PM_FILE_MAX_BYTES) rejected.push({ file: f, reason: 'larger than 25 MB' })
    else if (f.size === 0) rejected.push({ file: f, reason: 'empty' })
    else ok.push(f)
  }
  const error = rejected.length ? rejected.map((r) => `“${r.file.name}” — ${r.reason}`).join('; ') : null
  return { ok, error, rejected }
}
