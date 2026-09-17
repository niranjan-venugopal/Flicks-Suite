import type { CSSProperties, ReactNode } from 'react'
export const PM_PAGE: CSSProperties = { padding: '28px 32px 64px', maxWidth: 1280, margin: '0 auto' }
export function PmPage({ children, wide, style }: { children: ReactNode; wide?: boolean; style?: CSSProperties }) {
  return <div style={{ ...PM_PAGE, ...(wide ? { maxWidth: undefined } : null), ...style }}>{children}</div>
}
