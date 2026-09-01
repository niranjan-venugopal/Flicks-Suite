'use client'

import type { ReactNode } from 'react'
import { Btn } from './Btn'
import { Icon } from './Icon'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  sub?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** Round E — chrome-less dialogs (the Linear-style composer) render their
   *  own header row; `title` still labels the dialog for callers/tests. */
  hideHeader?: boolean
  /** Round E — override the body's default 22/24 padding. */
  bodyPadding?: number | string
}

export function Modal({ open, onClose, title, sub, children, footer, width = 560, hideHeader, bodyPadding }: ModalProps) {
  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        backdropFilter: 'blur(8px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // modal-card: opaque face — a glass card nested inside this overlay's
        // blur composites unreliably and disappears on near-black pages
        // (founder round D, the Delete-client dialog).
        className="card-glass modal-card"
        style={{
          width: '100%',
          maxWidth: width,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          borderRadius: 18,
          overflow: 'hidden',
        }}
      >
        {!hideHeader && (
        <div
          style={{
            padding: '22px 24px',
            borderBottom: '1px solid var(--bord)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 24,
          }}
        >
          {/* flex:1 + minWidth:0 so a long unbreakable title truncates inside
              the card instead of shoving the X out through overflow:hidden
              (founder round A — clipped close buttons). */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-h3">{title}</div>
            {sub && (
              <div className="t-mute" style={{ marginTop: 4 }}>
                {sub}
              </div>
            )}
          </div>
          {/* Negative margins centre the 32px button on the title line's
              ~19px centreline without growing the header. */}
          <div style={{ margin: '-6px -8px 0 0', flexShrink: 0 }}>
            <Btn kind="ghost" size="sm" icon={<Icon.x size={16} />} onClick={onClose} />
          </div>
        </div>
        )}
        <div style={{ padding: bodyPadding ?? '22px 24px', overflow: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid var(--bord)',
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
