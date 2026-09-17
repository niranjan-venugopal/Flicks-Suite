'use client'

import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { buildRichExtensions } from './extensions'
import type { FileUrlMap } from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — read-only markdown render, identical to what the editor
// shows (same extensions, editable: false), which is why it is a TipTap
// instance and not innerHTML: nothing user-authored ever reaches
// dangerouslySetInnerHTML. Inline images resolve through `fileUrls`;
// clicking one opens the signed URL in a new tab.
// ─────────────────────────────────────────────────────────

export interface RichViewProps {
  value: string
  fileUrls?: FileUrlMap
  /** Rendered instead of an empty document. */
  empty?: React.ReactNode
  className?: string
  style?: CSSProperties
  testId?: string
}

export function RichView({ value, fileUrls, empty, className = '', style, testId }: RichViewProps) {
  const fileUrlsRef = useRef<FileUrlMap>(fileUrls ?? {})
  fileUrlsRef.current = fileUrls ?? {}
  const lastRef = useRef(value)

  const extensions = useMemo(
    () =>
      buildRichExtensions({
        placeholder: () => '',
        resolveSrc: (id) => fileUrlsRef.current[id] ?? null,
        onSubmit: () => false,
        viewMode: true,
      }),
    [],
  )

  const editor = useEditor(
    {
      extensions,
      content: value,
      editable: false,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: { attributes: { class: 'pm-rich-content' } },
    },
    [],
  )

  useEffect(() => {
    if (!editor || value === lastRef.current) return
    lastRef.current = value
    editor.commands.setContent(value || '', false)
  }, [editor, value])

  // A freshly signed url map (detail/files refetch) re-renders image nodes —
  // keyed on the ENTRIES, so a re-signed URL for the same id reaches the DOM.
  const urlKey = useMemo(
    () =>
      Object.entries(fileUrls ?? {})
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('|'),
    [fileUrls],
  )
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(lastRef.current || '', false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey])

  if (!value?.trim()) return <>{empty ?? null}</>

  return (
    <div
      className={`pm-rich pm-rich--view${className ? ` ${className}` : ''}`}
      style={style}
      data-testid={testId}
      onClick={(e) => {
        const img = (e.target as HTMLElement).closest?.('img[data-file-id]') as HTMLImageElement | null
        if (img && img.dataset.missing !== 'true' && img.src && !img.src.startsWith('data:')) {
          e.stopPropagation()
          window.open(img.src, '_blank', 'noopener')
        }
      }}
    >
      {editor ? <EditorContent editor={editor} /> : <div style={{ whiteSpace: 'pre-wrap' }}>{value}</div>}
    </div>
  )
}
