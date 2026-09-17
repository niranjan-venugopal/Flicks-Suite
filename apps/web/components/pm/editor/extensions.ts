'use client'

import { Extension, Node, mergeAttributes } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image, { type ImageOptions } from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { fileIdFromSrc } from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — the TipTap extension set shared by RichEditor (editing)
// and RichView (read-only). Storage stays MARKDOWN: tiptap-markdown parses
// the body on load and serializes it on every change with `html: false`, so
// raw HTML in a body is text, never markup.
//
// Inline images keep `src="flicks-file://<record_file_id>"` INSIDE the
// document — the markdown serializer writes that verbatim, so the stored
// body never carries a signed URL. PmImage resolves the id to a signed URL
// only when rendering the DOM (`resolve`), and falls back to an "Image
// unavailable" placeholder while the URL is unknown.
// ─────────────────────────────────────────────────────────

export type ResolveSrc = (fileId: string) => string | null

export const MISSING_IMAGE_SRC =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72" viewBox="0 0 240 72">' +
      '<rect x="0.5" y="0.5" width="239" height="71" rx="8" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.16)"/>' +
      '<text x="120" y="41" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="600" fill="rgba(255,255,255,0.5)">Image unavailable</text>' +
      '</svg>',
  )

interface PmImageOptions extends ImageOptions {
  resolve: ResolveSrc | null
}

/**
 * Image node whose DOM src is resolved from flicks-file://<id> at render
 * time. ONLY flicks-file:// images ever load: an `![](https://…)` in a body
 * (a viewer-IP beacon — the server unwraps those, this is the belt) and any
 * unknown id render the "Image unavailable" placeholder instead.
 */
export const PmImage = Image.extend<PmImageOptions>({
  addOptions() {
    return { ...this.parent?.(), resolve: null }
  },
  renderHTML({ HTMLAttributes }) {
    const attrs: Record<string, unknown> = { ...HTMLAttributes }
    const id = fileIdFromSrc(typeof attrs.src === 'string' ? attrs.src : null)
    const url = id ? (this.options.resolve?.(id) ?? null) : null
    if (id) attrs['data-file-id'] = id
    if (url) {
      attrs.src = url
    } else {
      attrs.src = MISSING_IMAGE_SRC
      attrs['data-missing'] = 'true'
    }
    return ['img', mergeAttributes(this.options.HTMLAttributes, attrs)]
  },
})

/**
 * Skeleton block that stands in for an image while its upload is in flight
 * (Linear-style). Inserted synchronously at the paste/drop point, swapped
 * for the image node on success, removed on failure — RichEditor finds it
 * again by `uploadId` in the CURRENT document, so it needs no position
 * mapping. It never serialises: a body saved mid-upload simply omits it.
 */
export const PmImagePlaceholder = Node.create({
  name: 'pmImagePlaceholder',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() {
    return {
      uploadId: { default: null, renderHTML: (attrs) => ({ 'data-pm-upload': attrs.uploadId }) },
      name: { default: '', renderHTML: () => ({}) },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-pm-upload]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'pm-rich-img-placeholder', contenteditable: 'false' }),
      ['span', {}, `Uploading ${String(node.attrs.name || 'image')}…`],
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize() {
          /* never persisted */
        },
        parse: {},
      },
    }
  },
})

/** Mod+Enter → submit (priority above StarterKit so nothing swallows it first). */
export const SubmitShortcut = Extension.create<{ onSubmit: () => boolean }>({
  name: 'pmSubmitShortcut',
  priority: 1000,
  addOptions() {
    return { onSubmit: () => false }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => this.options.onSubmit(),
    }
  },
})

export interface BuildExtensionsOptions {
  placeholder: () => string
  resolveSrc: ResolveSrc
  onSubmit: () => boolean
  /** Read-only rendering: links open on click. */
  viewMode?: boolean
}

export function buildRichExtensions(opts: BuildExtensionsOptions) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      dropcursor: { color: 'rgba(62,123,250,.9)', width: 2 },
    }),
    PmImage.configure({
      inline: false,
      allowBase64: false,
      resolve: opts.resolveSrc,
      HTMLAttributes: { class: 'pm-rich-img', loading: 'lazy' },
    }),
    PmImagePlaceholder,
    Link.configure({
      openOnClick: !!opts.viewMode,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      // Mirrors the server's cleanMarkdown: https only (javascript:, data:,
      // http: and friends render as plain text on both sides).
      isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && /^https:\/\//i.test(url.trim()),
    }),
    Placeholder.configure({
      placeholder: () => opts.placeholder(),
      showOnlyWhenEditable: true,
    }),
    Markdown.configure({
      html: false,
      tightLists: true,
      linkify: false,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    SubmitShortcut.configure({ onSubmit: opts.onSubmit }),
  ]
}
