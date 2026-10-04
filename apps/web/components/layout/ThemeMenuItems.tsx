'use client'

import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { useCurrentUser, useUpdateTheme } from '@/lib/api/queries/use-auth'
import { useTheme, type ThemePreference } from '@/lib/theme/theme'

/** The three preferences in display order — shared with profile/AppearanceCard. */
export const THEME_CHOICES: ReadonlyArray<{ value: ThemePreference; label: string; Icon: LucideIcon }> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

/**
 * Round O — the "Appearance" rows of the Topbar user menu. Rendered on BOTH
 * consoles (deliberately no `!isFam` guard): the platform console is a
 * different origin with no /profile, so this is its only way to switch.
 * Optimistic via useUpdateTheme (the theme flips on click, the PATCH follows);
 * disabled under impersonation because the API refuses the write there (403).
 */
export function ThemeMenuItems() {
  const { preference } = useTheme()
  const update = useUpdateTheme()
  const me = useCurrentUser()
  const impersonating = Boolean(me.data?.impersonatorUserId)

  return (
    <>
      {/* ink/60 (not the primitive's /40): 4.5:1 on the light menu glass. */}
      <DropdownMenuLabel className="text-ink/60">Appearance</DropdownMenuLabel>
      {THEME_CHOICES.map(({ value, label, Icon }) => {
        const selected = preference === value
        return (
          <DropdownMenuItem
            key={value}
            disabled={impersonating}
            data-testid={`topbar-theme-${value}`}
            onSelect={() => {
              if (!selected) update.mutate(value)
            }}
          >
            <Icon /> {label}
            {selected && <Check className="ml-auto" aria-label="Active" />}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
