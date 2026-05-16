'use client'

import Link from 'next/link'
import { Btn, Icon, Pill, SectionHead } from '@/components/proto'
import type { ReactNode } from 'react'

interface Props {
  title: string
  sub?: string
  sprintTag: string
  endpoints?: string[]
  icon?: ReactNode
}

/**
 * Renders a labelled "Coming in <sprint>" placeholder for every FAM nav
 * item that isn't yet wired. Lists the backend endpoints the page will
 * consume so the audit reviewer can verify they exist already.
 */
export function FamPlaceholder({
  title,
  sub,
  sprintTag,
  endpoints,
  icon,
}: Props) {
  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title={title}
          sub={sub}
          right={
            <Pill tone="yellow" dot>
              {sprintTag}
            </Pill>
          }
        />

        <div
          className="card"
          style={{
            padding: 48,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: 'var(--surf-2)',
              border: '1px solid var(--bord)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-mute)',
            }}
          >
            {icon ?? <Icon.warn size={22} />}
          </div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>
            Wiring up in {sprintTag}
          </div>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--text-mute)',
              maxWidth: 460,
              lineHeight: 1.5,
            }}
          >
            The backend endpoints below already exist; this page becomes a
            real surface in the next FAM commit. Tracking in
            /root/.claude/plans/rosy-crafting-globe.md (Sprint 3).
          </div>
          {endpoints && endpoints.length > 0 && (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: '10px 14px',
                background: 'var(--surf-1)',
                border: '1px solid var(--bord)',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-2)',
              }}
            >
              {endpoints.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <Link href="/fam/overview" style={{ textDecoration: 'none', marginTop: 4 }}>
            <Btn kind="secondary" size="sm" icon={<Icon.arrowL size={12} />}>
              Back to Overview
            </Btn>
          </Link>
        </div>
      </div>
    </div>
  )
}
