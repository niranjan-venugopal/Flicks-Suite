'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { toast } from '@/components/ui/use-toast'
import { buildRichExtensions } from './extensions'
import { fileSrc, type FileUrlMap } from '@/lib/pm/files'

// ─────────────────────────────────────────────────────────
// Round L item 6 — the Linear-style editor. Uncontrolled TipTap document,
// markdown in / markdown out (`value` seeds it and re-seeds it whenever the
// parent hands us something we did not just emit). Pasting or dropping an
// image uploads it through `onUploadImage` and places an image node at the
// cursor / drop point — between the lines, like Linear. Mod+Enter submits.
// Loaded with next/dynamic({ ssr: false }) via ./index.tsx — never import
// this file directly from a page.
// ─────────────────────────────────────────────────────────

export interface RichEditorHandle {
  editor: Editor | null
  focus(): void
  clear(): void
  insertText(text: string): void
  /** Replace the text just before the cursor that matches `pattern` (anchored at the end). */
  replaceTextBeforeCursor(pattern: RegExp, replacement: string): boolean
  textBeforeCursor(max?: number): string
  getMarkdown(): string
}

export interface RichEditorProps {
  /** Storage markdown (flicks-file:// image refs). */
  value: string
  onChange: (markdown: string) => void
  /** Mod+Enter. */
  onSubmit?: () => void
  placeholder?: string
  /** record_file id → signed url, for images already on the server. */
  fileUrls?: FileUrlMap
  /** Pasted/dropped image → upload (kind 'inline') → `{ id, url }`; null/throw = not inserted. */
  onUploadImage?: (file: File) => Promise<{ id: string; url: string | null } | null>
  minHeight?: number
  autoFocus?: boolean
  readOnly?: boolean
  /** Raw keydown hook (mention pickers etc.). Return true to consume the key. */
  onKeyDown?: (event: KeyboardEvent, editor: Editor) => boolean
  /** Fires on every change/selection move with the ~80 chars before the cursor. */
  onCursorText?: (textBeforeCursor: string) => void
  /** Imperative access — a ref object, not `ref`, so it survives the dynamic() wrapper. */
  handleRef?: MutableRefObject<RichEditorHandle | null>
  compact?: boolean
  className?: string
  style?: CSSProperties
  testId?: string
}

const MENTION_LOOKBACK = 80

function textBefore(editor: Editor, max = MENTION_LOOKBACK): string {
  const { from } = editor.state.selection
  const start = Math.max(0, from - max)
  try {
    return editor.state.doc.textBetween(start, from, '\n', ' ')
  } catch {
    return ''
  }
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

/** The in-flight placeholder for an upload, wherever it is in the CURRENT doc. */
function findPlaceholder(ed: Editor, uploadId: string): { pos: number; node: ProseMirrorNode } | null {
  let out: { pos: number; node: ProseMirrorNode } | null = null
  ed.state.doc.descendants((node, pos) => {
    if (out) return false
    if (node.type.name === 'pmImagePlaceholder' && node.attrs.uploadId === uploadId) {
      out = { pos, node }
      return false
    }
    return true
  })
  return out
}

export function RichEditor({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  fileUrls,
  onUploadImage,
  minHeight = 80,
  autoFocus,
  readOnly,
  onKeyDown,
  onCursorText,
  handleRef,
  compact,
  className = '',
  style,
  testId = 'rich-editor',
}: RichEditorProps) {
  // Callbacks and maps live in refs: the TipTap instance is created once and
  // its extensions/editorProps capture these at construction.
  const onChangeRef = useRef(onChange)
  const onSubmitRef = useRef(onSubmit)
  const onKeyDownRef = useRef(onKeyDown)
  const onCursorTextRef = useRef(onCursorText)
  const onUploadRef = useRef(onUploadImage)
  const placeholderRef = useRef(placeholder)
  const fileUrlsRef = useRef<FileUrlMap>(fileUrls ?? {})
  const localUrlsRef = useRef<FileUrlMap>({})
  const editorRef = useRef<Editor | null>(null)
  const lastEmittedRef = useRef<string>(value)
  onChangeRef.current = onChange
  onSubmitRef.current = onSubmit
  onKeyDownRef.current = onKeyDown
  onCursorTextRef.current = onCursorText
  onUploadRef.current = onUploadImage
  placeholderRef.current = placeholder
  fileUrlsRef.current = fileUrls ?? {}

  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const extensions = useMemo(
    () =>
      buildRichExtensions({
        placeholder: () => placeholderRef.current,
        resolveSrc: (id) => fileUrlsRef.current[id] ?? localUrlsRef.current[id] ?? null,
        onSubmit: () => {
          if (!onSubmitRef.current) return false
          onSubmitRef.current()
          return true
        },
      }),
    [],
  )

  /**
   * Linear-style: a skeleton block goes in SYNCHRONOUSLY at the paste/drop
   * point (one per file, in order), uploads run in parallel, and each
   * placeholder is swapped for the image (or removed + toasted) by finding
   * it again in the current document — whatever was typed meanwhile.
   */
  const uploadAndInsert = async (files: File[], at: number | null) => {
    const upload = onUploadRef.current
    const ed = editorRef.current
    if (!upload || !ed || !files.length) return
    setError(null)
    const jobs: Array<{ id: string; file: File }> = []
    let pos = at ?? ed.state.selection.head
    for (const file of files) {
      const id = crypto.randomUUID()
      ed.chain().insertContentAt(pos, { type: 'pmImagePlaceholder', attrs: { uploadId: id, name: file.name } }).run()
      const found = findPlaceholder(ed, id)
      pos = found ? found.pos + found.node.nodeSize : ed.state.selection.head
      jobs.push({ id, file })
    }
    setUploading((n) => n + jobs.length)
    await Promise.all(
      jobs.map(async ({ id, file }) => {
        try {
          const res = await upload(file)
          if (!res) throw new Error('Upload cancelled')
          if (res.url) localUrlsRef.current[res.id.toLowerCase()] = res.url
          const cur = editorRef.current
          const found = cur ? findPlaceholder(cur, id) : null
          if (cur && found) {
            const image = cur.schema.nodes.image!.create({ src: fileSrc(res.id), alt: file.name })
            cur.view.dispatch(cur.state.tr.replaceWith(found.pos, found.pos + found.node.nodeSize, image))
          }
        } catch (err) {
          const cur = editorRef.current
          const found = cur ? findPlaceholder(cur, id) : null
          if (cur && found) cur.view.dispatch(cur.state.tr.delete(found.pos, found.pos + found.node.nodeSize))
          const message = err instanceof Error ? err.message : 'Image upload failed'
          setError(message)
          toast({ title: `Couldn’t add ${file.name}`, description: message, variant: 'destructive' })
        } finally {
          setUploading((n) => Math.max(0, n - 1))
        }
      }),
    )
  }

  const editor = useEditor(
    {
      extensions,
      content: value,
      editable: !readOnly,
      autofocus: autoFocus ? 'end' : false,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: 'pm-rich-content', spellcheck: 'true' },
        handleKeyDown: (_view: EditorView, event: KeyboardEvent) => {
          const ed = editorRef.current
          if (!ed || !onKeyDownRef.current) return false
          return onKeyDownRef.current(event, ed)
        },
        handlePaste: (_view: EditorView, event: ClipboardEvent) => {
          const files = imageFiles(event.clipboardData?.files)
          if (!files.length || !onUploadRef.current) return false
          event.preventDefault()
          void uploadAndInsert(files, null)
          return true
        },
        handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
          if (moved) return false
          const files = imageFiles(event.dataTransfer?.files)
          if (!files.length || !onUploadRef.current) return false // other files → the outer DropZone
          event.preventDefault()
          event.stopPropagation() // keep the outer DropZone from attaching the same image twice
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null
          void uploadAndInsert(files, pos)
          return true
        },
      },
      onUpdate: ({ editor: ed }) => {
        const md = (ed.storage as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()
        lastEmittedRef.current = md
        onChangeRef.current(md)
        onCursorTextRef.current?.(textBefore(ed))
      },
      onSelectionUpdate: ({ editor: ed }) => {
        onCursorTextRef.current?.(textBefore(ed))
      },
    },
    [],
  )
  editorRef.current = editor

  // Parent-driven resets (Cancel, post-submit clear, server echo).
  useEffect(() => {
    if (!editor) return
    if (value === lastEmittedRef.current) return
    lastEmittedRef.current = value
    editor.commands.setContent(value || '', false)
  }, [value, editor])

  useEffect(() => {
    if (editor && editor.isEditable === !!readOnly) editor.setEditable(!readOnly)
  }, [editor, readOnly])

  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      editor,
      focus: () => editor?.commands.focus('end'),
      clear: () => {
        lastEmittedRef.current = ''
        editor?.commands.clearContent(false)
      },
      insertText: (text) => {
        editor?.chain().focus().insertContent({ type: 'text', text }).run()
      },
      replaceTextBeforeCursor: (pattern, replacement) => {
        if (!editor) return false
        const text = textBefore(editor)
        const m = pattern.exec(text)
        if (!m) return false
        const { from } = editor.state.selection
        const start = from - m[0].length
        if (start < 0) return false
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.insertText(replacement, start, from)
            return true
          })
          .run()
        return true
      },
      textBeforeCursor: (max) => (editor ? textBefore(editor, max) : ''),
      getMarkdown: () =>
        editor ? (editor.storage as { markdown: { getMarkdown(): string } }).markdown.getMarkdown() : '',
    }
    return () => {
      handleRef.current = null
    }
  }, [editor, handleRef])

  useEffect(() => {
    if (!error) return
    const t = window.setTimeout(() => setError(null), 5000)
    return () => window.clearTimeout(t)
  }, [error])

  const cls =
    'pm-rich ' +
    (readOnly ? 'pm-rich--view' : 'pm-rich--edit') +
    (compact ? ' pm-rich--compact' : '') +
    (className ? ` ${className}` : '')

  return (
    <div className={cls} style={{ minHeight, position: 'relative', ...style }} data-testid={testId}>
      {editor ? <EditorContent editor={editor} /> : <div style={{ minHeight }} />}
      {uploading > 0 && (
        <div className="pm-rich-status">Uploading image{uploading > 1 ? 's' : ''}…</div>
      )}
      {error && <div className="pm-rich-status pm-rich-error">{error}</div>}
    </div>
  )
}
