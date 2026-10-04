'use client'

import { SectionHead } from '@/components/proto'
import { THEME_CHOICES } from '@/components/layout/ThemeMenuItems'
import { useCurrentUser, useUpdateTheme } from '@/lib/api/queries/use-auth'
import { useTheme } from '@/lib/theme/theme'

/**
 * Round O — Appearance (System / Light / Dark) on /profile, the one page every
 * tenant role incl. guests can open. The segmented control is the PM email
 * digest control (pm/settings/notifications) tokenised. Selection is
 * optimistic via useUpdateTheme and persisted to users.theme, so it follows
 * the person to every device (the FAM console is a different origin).
 */
export function AppearanceCard() {
  const { preference } = useTheme()
  const update = useUpdateTheme()
  const me = useCurrentUser()
  // The API refuses preference writes under impersonation (403) — say so up
  // front instead of letting the click bounce.
  const impersonating = Boolean(me.data?.impersonatorUserId)

  return (
    <div id="appearance" className="card" style={{ marginTop: 18 }}>
      <SectionHead title="Appearance" sub="How Flicks Suite looks for you — remembered on every device" />
      <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="Appearance">
        {THEME_CHOICES.map(({ value, label, Icon }) => {
          const selected = preference === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`appearance-${value}`}
              disabled={impersonating}
              onClick={() => {
                if (!selected) update.mutate(value)
              }}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 9, cursor: impersonating ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                background: selected ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : 'var(--surf-1)',
                border: `1px solid ${selected ? 'color-mix(in srgb, var(--blue) 45%, transparent)' : 'var(--bord)'}`,
                color: selected ? 'var(--text)' : 'var(--text-2)',
                fontSize: 11.5, fontWeight: 800, opacity: impersonating ? 0.5 : 1,
              }}
            >
              <Icon size={14} /> {label}
            </button>
          )
        })}
      </div>
      {/* --text-mute, not --text-faint: the impersonation sentence is load-bearing and faint is 3.4:1 on white. */}
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-mute)', marginTop: 9 }} data-testid="appearance-hint">
        {impersonating
          ? 'Appearance can’t be changed while impersonating — it belongs to the person you’re signed in as.'
          : 'System follows your device setting'}
      </div>
    </div>
  )
}
