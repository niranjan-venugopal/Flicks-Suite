'use client'

import dynamic from 'next/dynamic'
import type { RichEditorProps } from './RichEditor'
import type { RichViewProps } from './RichView'

export type { RichEditorHandle, RichEditorProps } from './RichEditor'
export type { RichViewProps } from './RichView'

// TipTap + ProseMirror are PM-page-only weight and touch `document` at
// import time: both surfaces load on the client, on first use.
export const RichEditor = dynamic<RichEditorProps>(() => import('./RichEditor').then((m) => m.RichEditor), {
  ssr: false,
  loading: () => <div className="pm-rich pm-rich--edit" style={{ minHeight: 80 }} />,
})

export const RichView = dynamic<RichViewProps>(() => import('./RichView').then((m) => m.RichView), {
  ssr: false,
  loading: () => null,
})
