'use client'

import { useMemo, useState } from 'react'
import { Btn, Icon, Modal } from '@/components/proto'
import { ProjectIcon } from './ProjectIcon'
import {
  DEFAULT_PROJECT_ICON,
  HEX_COLOR_RE,
  PROJECT_COLORS,
  PROJECT_ICON_PREFIX,
  iconLabel,
  isLucideIcon,
  searchProjectIcons,
  tileColor,
} from './icons/project-icons'

// ─────────────────────────────────────────────────────────
// Round P R5 — the project icon / image picker. One modal, two tabs:
//   Icon  — search + grouped grid of lucide glyphs on the chosen colour, a
//           12-swatch colour row, a live 48 px preview with the project name.
//   Image — "Upload an image" (hands off to the caller's crop flow) and, when
//           the project already has one, "Remove image".
// A project shows EITHER an icon tile OR an image: picking a glyph commits
// `(icon, colour)` through `onPick` and closes (the server drops the image on
// any icon write). A swatch commits straight away too — but only while the
// project is already drawing a lucide tile (no image, not a legacy emoji),
// so a colour click can never silently remove an image; the modal stays
// open so the glyph can still be changed in the same visit.
//
// The body mounts fresh on every open (tab / search / swatch state lives in
// the inner component), so a visit never flashes the previous visit's tab
// and a live `hasImage` flip mid-visit (another member's upload arriving in
// a delta) never yanks the tab or wipes the swatch just chosen.
// ─────────────────────────────────────────────────────────

export interface ProjectVisualPickerProps {
  open: boolean
  onClose: () => void
  /** The stored icon: `lucide:<name>`, a legacy emoji, or nothing. */
  icon: string | null | undefined
  /** The stored colour (#RRGGBB) or nothing — the tile then follows the name. */
  color: string | null | undefined
  /** Seeds the fallback colour + sits under the preview tile. */
  name: string
  /** True while the project shows an uploaded image. */
  hasImage: boolean
  /**
   * Commit. `colorPicked` is true when the person clicked a swatch in this
   * visit (vs. the colour merely riding along with a glyph pick) — the create
   * modal uses it to stop following the name once a colour is chosen.
   */
  onPick: (icon: string, color: string, colorPicked?: boolean) => void
  /** Image tab → "Upload an image" (the caller opens its crop / file flow). */
  onUploadImage: () => void
  /** Image tab → "Remove image" (only offered when `hasImage`). */
  onRemoveImage: () => void
}

type Tab = 'icon' | 'image'

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '5px 12px',
  borderRadius: 5,
  border: 'none',
  cursor: 'pointer',
  background: active ? 'var(--surf-3)' : 'transparent',
  color: active ? 'var(--text)' : 'var(--text-2)',
  fontSize: 11,
  fontWeight: 800,
})

export function ProjectVisualPicker({ open, ...props }: ProjectVisualPickerProps) {
  // Mount the body only while open: its state is created at mount, so each
  // visit starts fresh with no post-paint reset (and no stale first frame).
  if (!open) return null
  return <PickerBody {...props} />
}

function PickerBody({
  onClose,
  icon,
  color,
  name,
  hasImage,
  onPick,
  onUploadImage,
  onRemoveImage,
}: Omit<ProjectVisualPickerProps, 'open'>) {
  // The Image tab first when the project is showing an image (that is where
  // "Remove image" lives), the Icon tab otherwise — decided once, at open.
  const [tab, setTab] = useState<Tab>(() => (hasImage ? 'image' : 'icon'))
  const [query, setQuery] = useState('')
  // null = follow the stored colour; a swatch click overrides it for this visit.
  const [localColor, setLocalColor] = useState<string | null>(null)

  // The glyph with a ring. A project with no icon stored draws the default
  // tile everywhere, so it is selected as that glyph here: a swatch click
  // re-tints it without a second click on the grid. A legacy emoji genuinely
  // has no glyph — nothing is ringed until one is picked (it replaces the emoji).
  const selectedIcon = isLucideIcon(icon)
    ? icon.slice(PROJECT_ICON_PREFIX.length)
    : icon
      ? null
      : DEFAULT_PROJECT_ICON.slice(PROJECT_ICON_PREFIX.length)
  const storedColor = color && HEX_COLOR_RE.test(color) ? color : null
  // The swatch with a ring: the explicit choice, else the stored one, else
  // none (a legacy emoji project opens with nothing selected).
  const selectedColor = localColor ?? storedColor
  // What the grid and preview are drawn in — always a real hex.
  const drawColor = tileColor(selectedColor, name)
  const previewIcon = selectedIcon ? `${PROJECT_ICON_PREFIX}${selectedIcon}` : DEFAULT_PROJECT_ICON
  const groups = useMemo(() => searchProjectIcons(query), [query])
  const total = groups.reduce((n, g) => n + g.icons.length, 0)

  const pickGlyph = (bare: string) => {
    onPick(`${PROJECT_ICON_PREFIX}${bare}`, drawColor, localColor !== null)
    onClose()
  }
  // A swatch commits on its own only while the tile is already a lucide glyph
  // with no image in front of it — a colour change should never need a second
  // click on the glyph that is already selected. Otherwise (an image is
  // showing, or a legacy emoji) the swatch only re-tints the preview until a
  // glyph is picked, and the row says so.
  const colorCommits = !!selectedIcon && !hasImage
  const pickColor = (value: string) => {
    setLocalColor(value)
    if (colorCommits) onPick(`${PROJECT_ICON_PREFIX}${selectedIcon}`, value, true)
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Project icon"
      sub="An icon on a colour tile, or an uploaded image — one or the other."
      bodyPadding="16px 24px 22px"
    >
      {/* Tabs — the house segmented control (projects list tabs). */}
      <div role="tablist" aria-label="Project icon or image" style={{ display: 'inline-flex', gap: 3, padding: 3, background: 'var(--surf-1)', border: '1px solid var(--bord)', borderRadius: 8, marginBottom: 14 }}>
        <button type="button" role="tab" aria-selected={tab === 'icon'} data-testid="project-visual-tab-icon" onClick={() => setTab('icon')} style={tabBtn(tab === 'icon')}>
          Icon
        </button>
        <button type="button" role="tab" aria-selected={tab === 'image'} data-testid="project-visual-tab-image" onClick={() => setTab('image')} style={tabBtn(tab === 'image')}>
          Image
        </button>
      </div>

      {tab === 'icon' ? (
        <div role="tabpanel" data-testid="project-visual-icon-panel">
          {/* Live preview — the tile exactly as the rest of the app will draw it. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <ProjectIcon icon={previewIcon} color={drawColor} name={name} size={48} title={iconLabel(previewIcon)} />
            <div style={{ minWidth: 0 }}>
              <div data-testid="project-visual-preview-name" style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name.trim() || 'Untitled project'}
              </div>
              <div className="t-mute" style={{ fontSize: 11 }}>
                {selectedIcon ? iconLabel(selectedIcon) : 'No icon picked yet'}
                {' · '}
                {PROJECT_COLORS.find((c) => c.value === drawColor)?.label ?? drawColor}
                {!selectedColor && ' by default'}
                {hasImage && ' · picking an icon removes the uploaded image'}
              </div>
            </div>
          </div>

          {/* Colour row */}
          <div className="label" style={{ marginBottom: 6 }}>Colour</div>
          <div role="group" aria-label="Tile colour" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {PROJECT_COLORS.map((c) => {
              const on = c.value === selectedColor
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-label={c.label}
                  title={c.label}
                  aria-pressed={on}
                  data-color-option={c.value}
                  onClick={() => pickColor(c.value)}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    background: c.value,
                    color: '#fff',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: on ? '0 0 0 2px var(--surf-pop), 0 0 0 4px var(--text)' : 'none',
                    flexShrink: 0,
                  }}
                >
                  {on && <Icon.check size={13} />}
                </button>
              )
            })}
          </div>
          {localColor !== null && !colorCommits && (
            <div className="t-mute" data-testid="project-visual-color-hint" style={{ fontSize: 11, marginTop: -8, marginBottom: 14 }}>
              Pick an icon to use this colour{hasImage ? ' — that removes the uploaded image' : ''}.
            </div>
          )}

          {/* Search */}
          <input
            autoFocus
            className="input"
            aria-label="Search icons"
            placeholder="Search icons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
            style={{ height: 34, fontSize: 12.5, marginBottom: 12 }}
          />

          {/* Grouped grid — flex-wrap so a 390 px phone simply wraps more. */}
          {total === 0 ? (
            <div className="t-mute" style={{ fontSize: 12, padding: '18px 0', textAlign: 'center' }}>
              No icons match “{query.trim()}”.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.group} style={{ marginBottom: 12 }}>
                <div className="t-caption" style={{ fontSize: 9.5, marginBottom: 6 }}>{g.group}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {g.icons.map((n) => {
                    const on = n === selectedIcon
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-label={iconLabel(n)}
                        title={iconLabel(n)}
                        aria-pressed={on}
                        data-icon-option={n}
                        onClick={() => pickGlyph(n)}
                        style={{
                          padding: 0,
                          border: 'none',
                          background: 'transparent',
                          borderRadius: 10,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          boxShadow: on ? '0 0 0 2px var(--surf-pop), 0 0 0 4px var(--text)' : 'none',
                        }}
                      >
                        <ProjectIcon icon={`${PROJECT_ICON_PREFIX}${n}`} color={drawColor} name={name} size={36} />
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div role="tabpanel" data-testid="project-visual-image-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: 13, background: 'var(--surf-2)', border: '1px solid var(--bord)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', flexShrink: 0 }}>
              <Icon.image size={20} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, letterSpacing: '-0.02em' }}>
                {hasImage ? 'This project shows an uploaded image' : 'Use your own image instead'}
              </div>
              <div className="t-mute" style={{ fontSize: 11, lineHeight: 1.5 }}>
                JPG, PNG or WebP · squared automatically · it replaces the icon tile while it is there.
                {hasImage && ' Remove it, or pick an icon, to get the tile back.'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn
              kind="primary"
              size="sm"
              icon={<Icon.upload size={13} />}
              data-testid="project-visual-upload"
              onClick={() => { onClose(); onUploadImage() }}
            >
              Upload an image
            </Btn>
            {hasImage && (
              <Btn
                kind="danger"
                size="sm"
                icon={<Icon.trash size={13} />}
                data-testid="project-visual-remove"
                onClick={() => { onClose(); onRemoveImage() }}
              >
                Remove image
              </Btn>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
