'use client'

import type { CSSProperties, ReactNode } from 'react'

export type PillTone = '' | 'blue' | 'green' | 'yellow' | 'coral' | 'purple'

interface PillProps {
  tone?: PillTone
  icon?: ReactNode
  dot?: boolean
  children?: ReactNode
  style?: CSSProperties
  className?: string
}

export function Pill({ tone = '', icon, dot, children, style, className = '' }: PillProps) {
  return (
    <span className={`pill ${tone}${className ? ' ' + className : ''}`} style={style}>
      {dot && <span className={`dot ${tone}`} />}
      {icon}
      {children}
    </span>
  )
}
