'use client'

/**
 * Round Q — the house segmented pill (the attendance page's "My attendance |
 * Everyone" switch, the calendar's ViewSwitch) as one reusable control.
 */
export function Segmented<K extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  testIdPrefix,
}: {
  value: K
  onChange: (key: K) => void
  options: ReadonlyArray<{ key: K; label: string }>
  ariaLabel: string
  testIdPrefix?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        gap: 3,
        padding: 3,
        background: 'var(--surf-1)',
        border: '1px solid var(--bord)',
        borderRadius: 9,
      }}
    >
      {options.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => value !== key && onChange(key)}
          data-testid={testIdPrefix ? `${testIdPrefix}-${key}` : undefined}
          style={{
            padding: '6px 12px',
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            background: value === key ? 'var(--surf-3)' : 'transparent',
            color: value === key ? 'var(--text)' : 'var(--text-2)',
            fontSize: 11.5,
            fontWeight: 800,
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
