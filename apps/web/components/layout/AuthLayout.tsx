'use client'

import { LogoMark } from '@/components/proto'

interface AuthLayoutProps {
  /** Optional 1-indexed step counter to render the segmented progress pill. */
  step?: number
  total?: number
  label?: string
  /** Hide the right-hand "Need help?" button (e.g. on standalone pages). */
  hideHelp?: boolean
  children: React.ReactNode
}

/**
 * Auth flow wrapper — full-bleed page with the brand glow blobs, a slim
 * header (LogoMark + "Flicks Suite · by Specflicks" + optional step pill +
 * "Need help?"), and a centered body for the AuthCard.
 *
 * Mirrors the prototype's AuthLayout in repo/project/ui_kits/flicks-hrms-pro/
 * src/shell.jsx so signup, OTP, workspace setup, login, and magic-link sent
 * all share the same frame.
 */
export function AuthLayout({
  step,
  total,
  label,
  hideHelp,
  children,
}: AuthLayoutProps) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Glow blobs — same positions as the prototype */}
      <div
        className="glow glow-blue"
        style={{ top: -200, left: -150, width: 600, height: 600 }}
      />
      <div
        className="glow glow-coral"
        style={{ bottom: -200, right: -150, width: 500, height: 500 }}
      />
      <div
        className="glow glow-purple"
        style={{ top: '30%', right: '20%', width: 400, height: 400 }}
      />

      <header
        style={{
          padding: '24px 36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'relative',
          zIndex: 1,
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <LogoMark size={36} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.02em' }}>
              Flicks Suite
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)' }}>
              by Specflicks
            </div>
          </div>
        </div>

        {step !== undefined && total !== undefined && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 14px',
              background: 'var(--surf-1)',
              border: '1px solid var(--bord-2)',
              borderRadius: 99,
            }}
          >
            <div style={{ display: 'flex', gap: 4 }}>
              {Array.from({ length: total }, (_, i) => (
                <div
                  key={i}
                  style={{
                    width: 18,
                    height: 3,
                    borderRadius: 99,
                    background:
                      i < step ? 'var(--blue)' : 'rgba(255,255,255,.12)',
                  }}
                />
              ))}
            </div>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 800,
                letterSpacing: '-0.01em',
              }}
            >
              {label ? `${label} · ` : ''}
              {step}/{total}
            </div>
          </div>
        )}

        {!hideHelp && (
          <button
            type="button"
            style={{
              padding: '8px 14px',
              borderRadius: 99,
              background: 'var(--surf-1)',
              border: '1px solid var(--bord-2)',
              color: 'var(--text-2)',
              fontSize: 11.5,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Need help?
          </button>
        )}
      </header>

      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 24px 48px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {children}
      </div>
    </div>
  )
}

interface AuthCardProps {
  width?: number
  children: React.ReactNode
}

export function AuthCard({ width = 480, children }: AuthCardProps) {
  return (
    <div
      className="card-glass"
      style={{
        width: '100%',
        maxWidth: width,
        padding: '40px 40px 36px',
        borderRadius: 20,
        position: 'relative',
      }}
    >
      {children}
    </div>
  )
}
