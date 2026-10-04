'use client'

/**
 * "Invo" design primitives — exact port of the approved Invoice Management
 * prototype (Specflicks Design System → ui_kits/invoice-management).
 *
 * Source values (do not eyeball-tweak):
 *  • page: padding 32/48, fixed ambient radial glows (blue/coral/green ≤8%)
 *  • cards: linear-gradient(rgba(255,255,255,.07–.10) → transparent), r16, p28
 *  • type: weight 700, letterSpacing −0.02em (−0.04em on big numbers); muted
 *    text = rgba(255,255,255,.3–.6). Font inherits the app's Gilroy (the
 *    prototype's Plus Jakarta Sans was a stand-in for Gilroy).
 *  • fields: h52 (h44 compact), bg rgba(255,255,255,.05), 1.5px border
 *    rgba(255,255,255,.10), r10
 *  • buttons: primary #3E7BFA h48 r10; secondary rgba(255,255,255,.08);
 *    outline 1.5px rgba(255,255,255,.2)
 *  • status chips: pill, rgba(color,.15) bg, colored 6px dot — paid #27D280,
 *    pending #FED800, overdue #F8786B
 *  • tables: th 13/700 rgba(255,255,255,.4); td 14/700 #fff p '16px 12px';
 *    row borders rgba(255,255,255,.05); zebra rgba(255,255,255,.01)
 *
 * Round O: the app-side primitives resolve those values from the theme tokens
 * (globals.css) so the module re-tints with <html data-theme>; in dark every
 * token is the prototype value above. The customer document palettes
 * (DARK_PALETTE / LIGHT_PALETTE) stay literal — they theme the invoice/PDF.
 * INVO.* used inside the customer document (InvoiceRenderer, PrintPaymentBlock,
 * /inv, /invoicing/:id/preview) resolves through app/(public)/layout.tsx's
 * data-theme="dark" wrapper; keep that wrapper, or move those sites onto
 * DARK_PALETTE / LIGHT_PALETTE.
 */

import type { CSSProperties, ReactNode } from 'react'
import { useTheme } from '@/lib/theme/theme'

// ─── tokens ──────────────────────────────────────────────────────────────────

// rgba(255,255,255,n%) of the prototype in dark; n% ink on white in light.
const ink = (pct: number) => `color-mix(in srgb, var(--text) ${pct}%, transparent)`

// Hex for non-CSS sinks only (Razorpay checkout `theme.color` renders in its
// own iframe and cannot read our custom properties). Everything painted by
// the app uses INVO.blue.
export const INVO_BRAND_BLUE = '#3E7BFA'

export const INVO = {
  blue: 'var(--blue)',
  green: 'var(--green)',
  yellow: 'var(--yellow)',
  coral: 'var(--coral)',
  text: 'var(--text)',
  muted30: 'var(--text-faint)',
  muted40: 'var(--text-faint)',
  muted50: 'var(--text-mute)',
  muted60: 'var(--text-2)',
  cardBg: `linear-gradient(${ink(7)} 0%, ${ink(2)} 100%)`,
  cardBgStrong: `linear-gradient(${ink(10)} 0%, transparent 100%)`,
  fieldBg: ink(5),
  fieldBorder: `1.5px solid ${ink(10)}`,
  rowBorder: `1px solid ${ink(5)}`,
  headBorder: `1px solid ${ink(7)}`,
  zebra: ink(1),
} as const

// ─── Invoice document theme (dark = app default, light = print/PDF option) ────

export type InvoiceThemeName = 'dark' | 'light'

export interface InvoicePalette {
  name: InvoiceThemeName
  pageBg: string
  cardBg: string
  cardBorder: string
  cardShadow: string
  text: string
  muted30: string
  muted40: string
  muted50: string
  muted60: string
  headBorder: string
  rowBorder: string
  divider: string
  qrBoxBg: string
  qrBoxBorder: string
  qrModule: string
}

// Literal on purpose: these palettes theme the customer's document (hosted
// invoice, print/PDF, preview) via its own toggle, never via <html data-theme>.
const DARK_PALETTE: InvoicePalette = {
  name: 'dark',
  pageBg: '#01010D',
  cardBg: 'linear-gradient(rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 100%)',
  cardBorder: '1px solid rgba(255,255,255,0.06)',
  cardShadow: 'none',
  text: '#fff',
  muted30: 'rgba(255,255,255,0.3)',
  muted40: 'rgba(255,255,255,0.4)',
  muted50: 'rgba(255,255,255,0.5)',
  muted60: 'rgba(255,255,255,0.6)',
  headBorder: '1px solid rgba(255,255,255,0.07)',
  rowBorder: '1px solid rgba(255,255,255,0.05)',
  divider: 'rgba(255,255,255,0.1)',
  qrBoxBg: '#ffffff',
  qrBoxBorder: 'none',
  qrModule: '#01010D',
}

const LIGHT_PALETTE: InvoicePalette = {
  name: 'light',
  pageBg: '#ffffff',
  cardBg: '#ffffff',
  cardBorder: '1px solid #e7e9f0',
  cardShadow: '0 1px 3px rgba(16,24,40,0.06)',
  text: '#101828',
  muted30: '#b0b7c3',
  muted40: '#98a2b3',
  muted50: '#667085',
  muted60: '#475467',
  headBorder: '1px solid #eaecf0',
  rowBorder: '1px solid #f0f1f4',
  divider: '#e4e7ec',
  qrBoxBg: '#ffffff',
  qrBoxBorder: '1px solid #eaecf0',
  qrModule: '#101828',
}

export const invoiceTheme = (name: InvoiceThemeName | undefined): InvoicePalette =>
  name === 'light' ? LIGHT_PALETTE : DARK_PALETTE

const FONT: CSSProperties = { fontFamily: 'inherit', letterSpacing: '-0.02em' }

// ─── page wrapper with ambient glows ────────────────────────────────────────

export function InvoPage({ children, glow = 'blue' }: { children: ReactNode; glow?: 'blue' | 'green' | 'coral' }) {
  const glowColor =
    glow === 'green'
      ? 'color-mix(in srgb, var(--green) 6%, transparent)'
      : glow === 'coral'
        ? 'color-mix(in srgb, var(--coral) 6%, transparent)'
        : 'color-mix(in srgb, var(--blue) 8%, transparent)'
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 48px', position: 'relative', minWidth: 0 }}>
      <div
        style={{
          position: 'fixed',
          top: 100,
          right: 200,
          width: 400,
          height: 400,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <div
        style={{
          position: 'fixed',
          bottom: 100,
          left: 300,
          width: 300,
          height: 300,
          borderRadius: '50%',
          background: 'radial-gradient(circle, color-mix(in srgb, var(--coral) 6%, transparent) 0%, transparent 70%)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  )
}

// ─── section title (22/700 + icon) ──────────────────────────────────────────

export function InvoTitle({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
      <div style={{ ...FONT, fontWeight: 700, fontSize: 22, color: INVO.text, display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon}
        {children}
      </div>
      {right && <div style={{ display: 'flex', gap: 10 }}>{right}</div>}
    </div>
  )
}

// ─── gradient card ───────────────────────────────────────────────────────────

export function InvoCard({
  children,
  strong = false,
  style,
}: {
  children: ReactNode
  strong?: boolean
  style?: CSSProperties
}) {
  return (
    <div style={{ background: strong ? INVO.cardBgStrong : INVO.cardBg, borderRadius: 16, padding: 28, ...style }}>
      {children}
    </div>
  )
}

export function InvoCardTitle({ children }: { children: ReactNode }) {
  return <div style={{ ...FONT, fontWeight: 700, fontSize: 18, color: INVO.text, marginBottom: 20 }}>{children}</div>
}

// ─── fields ──────────────────────────────────────────────────────────────────

export const invoField = (compact = false): CSSProperties => ({
  width: '100%',
  height: compact ? 44 : 52,
  background: INVO.fieldBg,
  border: INVO.fieldBorder,
  borderRadius: 10,
  padding: '0 16px',
  ...FONT,
  fontWeight: 600,
  fontSize: 14,
  color: INVO.text,
  outline: 'none',
})

// Native-<select> reset: kill the OS "silver" gradient control and draw our
// own chevron (same treatment select.input gets in globals.css). Spread AFTER
// a base field style — backgroundImage must come after any `background`
// shorthand or the chevron is erased.
export const invoSelectReset: CSSProperties = {
  appearance: 'none',
  WebkitAppearance: 'none',
  paddingRight: 40,
  backgroundImage: 'var(--chevron)',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 14px center',
  backgroundSize: 16,
}

// invoField's <select> flavour.
export const invoSelect = (compact = false): CSSProperties => ({
  ...invoField(compact),
  ...invoSelectReset,
})

export const invoLabel: CSSProperties = {
  ...FONT,
  fontWeight: 700,
  fontSize: 13,
  color: INVO.muted60,
  marginBottom: 6,
  display: 'block',
}

// ─── buttons ─────────────────────────────────────────────────────────────────

type InvoBtnKind = 'primary' | 'secondary' | 'outline' | 'dashed' | 'chip-blue' | 'chip-outline'

export function InvoBtn({
  kind = 'secondary',
  children,
  icon,
  onClick,
  disabled,
  full,
  height,
  type = 'button',
  title,
}: {
  kind?: InvoBtnKind
  children?: ReactNode
  icon?: ReactNode
  onClick?: () => void
  disabled?: boolean
  full?: boolean
  height?: number
  type?: 'button' | 'submit'
  title?: string
}) {
  const base: CSSProperties = {
    height: height ?? (kind.startsWith('chip') ? undefined : 48),
    padding: kind.startsWith('chip') ? '6px 14px' : '0 20px',
    borderRadius: kind.startsWith('chip') ? 8 : 10,
    ...FONT,
    fontWeight: 700,
    fontSize: kind.startsWith('chip') ? 12 : 14,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    border: 'none',
    width: full ? '100%' : undefined,
    opacity: disabled ? 0.5 : 1,
  }
  const kinds: Record<InvoBtnKind, CSSProperties> = {
    primary: { background: INVO.blue, color: 'var(--on-accent)' },
    secondary: { background: ink(8), color: INVO.text },
    outline: { background: 'transparent', border: `1.5px solid ${ink(20)}`, color: 'var(--text-2)' },
    dashed: {
      background: 'transparent',
      border: `1.5px dashed ${ink(20)}`,
      color: INVO.muted50,
      padding: '8px 16px',
      height: undefined,
      fontSize: 13,
      borderRadius: 8,
    },
    'chip-blue': { background: 'color-mix(in srgb, var(--blue) 15%, transparent)', color: INVO.blue },
    'chip-outline': { background: 'transparent', border: `1px solid ${ink(15)}`, color: INVO.muted60 },
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} style={{ ...base, ...kinds[kind] }}>
      {icon}
      {children}
    </button>
  )
}

// ─── status chip (exact prototype mapping) ──────────────────────────────────

const tint = (token: string) => `color-mix(in srgb, var(--${token}) 15%, transparent)`
const CHIP_STYLES: Record<string, { label: string; bg: string; color: string }> = {
  PAID: { label: 'Paid', bg: tint('green'), color: INVO.green },
  SENT: { label: 'Pending', bg: tint('yellow'), color: INVO.yellow },
  VIEWED: { label: 'Viewed', bg: tint('yellow'), color: INVO.yellow },
  PARTIALLY_PAID: { label: 'Partial', bg: tint('yellow'), color: INVO.yellow },
  OVERDUE: { label: 'Overdue', bg: tint('coral'), color: INVO.coral },
  DRAFT: { label: 'Draft', bg: ink(10), color: INVO.muted60 },
  CANCELLED: { label: 'Cancelled', bg: ink(8), color: INVO.muted40 },
  VOIDED: { label: 'Voided', bg: ink(8), color: INVO.muted40 },
  WRITE_OFF: { label: 'Write-off', bg: tint('coral'), color: INVO.coral },
  DISPUTED: { label: 'Disputed', bg: tint('coral'), color: INVO.coral },
  REFUNDED: { label: 'Refunded', bg: tint('blue'), color: INVO.blue },
  active: { label: 'Active', bg: tint('green'), color: INVO.green },
  archived: { label: 'Archived', bg: ink(8), color: INVO.muted40 },
}

// Light-theme chip colors (the translucent-white neutrals above vanish on a
// white page). Only differs from CHIP_STYLES in bg + a readable text shade;
// labels are reused from CHIP_STYLES.
const CHIP_STYLES_LIGHT: Record<string, { bg: string; color: string }> = {
  PAID: { bg: '#E7F8EF', color: '#067647' },
  SENT: { bg: '#FEF7E6', color: '#B54708' },
  VIEWED: { bg: '#FEF7E6', color: '#B54708' },
  PARTIALLY_PAID: { bg: '#FEF7E6', color: '#B54708' },
  OVERDUE: { bg: '#FEECEB', color: '#B42318' },
  DRAFT: { bg: '#F2F4F7', color: '#475467' },
  CANCELLED: { bg: '#F2F4F7', color: '#5B6578' },
  VOIDED: { bg: '#F2F4F7', color: '#5B6578' },
  WRITE_OFF: { bg: '#FEECEB', color: '#B42318' },
  DISPUTED: { bg: '#FEECEB', color: '#B42318' },
  REFUNDED: { bg: '#EAF0FE', color: '#1D4ED8' },
  active: { bg: '#E7F8EF', color: '#067647' },
  archived: { bg: '#F2F4F7', color: '#5B6578' },
}

export function StatusChip({ status, theme }: { status: string; theme?: InvoiceThemeName }) {
  // An explicit `theme` is the customer document's toggle (InvoiceRenderer);
  // app surfaces leave it unset and follow the resolved app theme.
  const { resolved } = useTheme()
  const mode = theme ?? resolved
  const base = CHIP_STYLES[status] ?? { label: status, bg: ink(8), color: INVO.muted60 }
  const light = CHIP_STYLES_LIGHT[status]
  const s =
    mode === 'light'
      ? { label: base.label, bg: light?.bg ?? '#F2F4F7', color: light?.color ?? '#475467' }
      : base
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderRadius: 999,
        background: s.bg,
        color: s.color,
        ...FONT,
        fontWeight: 700,
        fontSize: 12,
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color }} />
      {s.label}
    </span>
  )
}

// ─── table styles ────────────────────────────────────────────────────────────

export const invoTh: CSSProperties = {
  ...FONT,
  fontWeight: 700,
  fontSize: 13,
  color: INVO.muted40,
  padding: '14px 12px',
  textAlign: 'left',
}
export const invoTd: CSSProperties = {
  ...FONT,
  fontWeight: 700,
  fontSize: 14,
  color: INVO.text,
  padding: '16px 12px',
}

export function InvoTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: INVO.headBorder }}>{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

export function InvoRow({
  index,
  children,
  onClick,
}: {
  index: number
  children: ReactNode
  onClick?: () => void
}) {
  return (
    <tr
      onClick={onClick}
      style={{
        borderBottom: INVO.rowBorder,
        background: index % 2 === 0 ? 'transparent' : INVO.zebra,
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      {children}
    </tr>
  )
}

// ─── underline tabs ──────────────────────────────────────────────────────────

export function InvoTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[]
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid var(--bord)', marginBottom: 4 }}>
      {tabs.map((t) => (
        <div
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: '8px 16px',
            cursor: 'pointer',
            ...FONT,
            fontWeight: 700,
            fontSize: 14,
            color: active === t.id ? INVO.text : 'var(--text-faint)',
            borderBottom: active === t.id ? '2px solid var(--text)' : '2px solid transparent',
            marginBottom: -2,
          }}
        >
          {t.label}
        </div>
      ))}
    </div>
  )
}

// ─── avatar circle with initials ────────────────────────────────────────────

// [face, initials] — white on the solid blue, theme ink on the tints.
const AVATAR_BGS: Array<[string, string]> = [
  ['var(--blue)', 'var(--on-accent)'],
  [ink(12), 'var(--text)'],
  ['color-mix(in srgb, var(--coral) 40%, transparent)', 'var(--text)'],
  ['color-mix(in srgb, var(--green) 30%, transparent)', 'var(--text)'],
  ['color-mix(in srgb, var(--yellow) 25%, transparent)', 'var(--text)'],
]

export function InvoAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  // An empty name indexes NaN — fall back to the first face instead of throwing.
  const idx = name ? (name.charCodeAt(0) + name.length) % AVATAR_BGS.length : 0
  const [bg, fg] = AVATAR_BGS[idx] ?? AVATAR_BGS[0]!
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...FONT,
        fontWeight: 700,
        fontSize: size > 36 ? 14 : 13,
        color: fg,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  )
}

// ─── search input (prototype style) ─────────────────────────────────────────

export function InvoSearch({
  value,
  onChange,
  placeholder,
  width = 220,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  width?: number
}) {
  return (
    <div style={{ position: 'relative' }}>
      <svg
        style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          height: 44,
          paddingLeft: 38,
          paddingRight: 16,
          background: 'var(--surf-2)',
          border: `1.5px solid ${ink(10)}`,
          borderRadius: 10,
          ...FONT,
          fontWeight: 600,
          fontSize: 14,
          color: INVO.text,
          outline: 'none',
          width,
        }}
      />
    </div>
  )
}

// ─── prototype SVG icons ─────────────────────────────────────────────────────

export const InvoIcons = {
  download: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2v8m0 0 3-3m-3 3L5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  invoices: (
    <svg width="24" height="24" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="1" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M6 6h8M6 10h8M6 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  drafts: (
    <svg width="24" height="24" viewBox="0 0 22 22" fill="none">
      <path d="M4 1h10l5 5v15H4V1z" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M14 1v5h5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  clients: (
    <svg width="24" height="24" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 19c0-4 3.6-7 8-7s8 3 8 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  plus: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  plusSmall: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  trash: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  chevronRight: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6 4l4 4-4 4" stroke="var(--text-faint)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  arrow: (
    <svg width="14" height="12" viewBox="0 0 17 15" fill="currentColor">
      <path d="M10.5 15L2 6 2 8 10.5 0 7 0 0 7 0 8 7 15ZM17 9L17 6 2 6 2 9Z" />
    </svg>
  ),
  settings: (
    <svg width="24" height="24" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11 1v3M11 18v3M21 11h-3M4 11H1M18 4l-2 2M6 16l-2 2M18 18l-2-2M6 6L4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
} as const

// ─── breadcrumb ──────────────────────────────────────────────────────────────

export function InvoBreadcrumb({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {i > 0 && InvoIcons.chevronRight}
          <span
            onClick={item.onClick}
            style={{
              ...FONT,
              fontWeight: 700,
              fontSize: 15,
              color: i === items.length - 1 ? INVO.text : INVO.muted30,
              cursor: item.onClick ? 'pointer' : 'default',
            }}
          >
            {item.label}
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * Lifecycle stepper (states catalog) — Draft → Sent → Viewed → Partially
 * paid → Paid with the current stage highlighted; Overdue and Void branch
 * off Sent/Viewed and render as a coral/gray chip beside the trail.
 */
export function InvoiceStepper({ status }: { status: string }) {
  const TRAIL = ['DRAFT', 'SENT', 'VIEWED', 'PARTIALLY_PAID', 'PAID'] as const
  const LABEL: Record<string, string> = {
    DRAFT: 'Draft', SENT: 'Sent', VIEWED: 'Viewed', PARTIALLY_PAID: 'Partially paid', PAID: 'Paid',
  }
  const branch = ['OVERDUE', 'CANCELLED', 'VOIDED', 'WRITE_OFF'].includes(status) ? status : null
  // An overdue invoice has at least been sent — anchor the trail there.
  const anchor = branch ? 'SENT' : status
  const idx = TRAIL.indexOf(anchor as (typeof TRAIL)[number])
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {TRAIL.map((st, i) => {
        const on = idx >= i || status === 'PAID'
        const here = !branch && st === status
        return (
          <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span style={{ width: 14, height: 1.5, background: on ? 'var(--blue)' : 'var(--bord-2)' }} />}
            <span
              className={here ? 'pm-pop' : undefined}
              style={{
                padding: '3px 10px', borderRadius: 99, fontSize: 10, fontWeight: 800,
                background: here ? 'color-mix(in srgb, var(--blue) 14%, transparent)' : 'transparent',
                border: `1px solid ${on ? 'color-mix(in srgb, var(--blue) 45%, transparent)' : 'var(--bord)'}`,
                color: on ? 'var(--text)' : 'var(--text-faint)',
              }}
            >
              {LABEL[st]}
            </span>
          </span>
        )
      })}
      {branch && (
        <span className="pm-pop" style={{
          marginLeft: 6, padding: '3px 10px', borderRadius: 99, fontSize: 10, fontWeight: 800,
          background: branch === 'OVERDUE' ? 'color-mix(in srgb, var(--coral) 12%, transparent)' : 'var(--surf-2)',
          border: branch === 'OVERDUE' ? '1px solid color-mix(in srgb, var(--coral) 40%, transparent)' : '1px solid var(--bord-2)',
          color: branch === 'OVERDUE' ? 'var(--coral)' : 'var(--text-mute)',
        }}>
          {branch === 'OVERDUE' ? 'Overdue' : branch === 'WRITE_OFF' ? 'Write-off' : branch[0] + branch.slice(1).toLowerCase()}
        </span>
      )}
    </div>
  )
}
