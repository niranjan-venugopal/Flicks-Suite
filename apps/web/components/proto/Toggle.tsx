'use client'

interface ToggleProps {
  on: boolean
  onChange?: (next: boolean) => void
}

export function Toggle({ on, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange?.(!on)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 99,
        padding: 2,
        background: on ? 'var(--blue)' : 'rgba(255,255,255,.14)',
        transition: 'background .2s',
        cursor: 'pointer',
        border: 'none',
        display: 'flex',
        alignItems: 'center',
      }}
      aria-pressed={on}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          transform: on ? 'translateX(16px)' : 'translateX(0)',
          transition: 'transform .2s',
          boxShadow: '0 2px 4px rgba(0,0,0,.3)',
        }}
      />
    </button>
  )
}
