'use client'

interface BarDatum {
  label: string
  value: number
  color?: string
  dim?: boolean
}

interface BarChartProps {
  data: BarDatum[]
  color?: string
  h?: number
  gap?: number
}

export function BarChart({ data, color = '#3E7BFA', h = 120, gap = 4 }: BarChartProps) {
  const max = Math.max(...data.map((d) => d.value), 1)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap, height: h, width: '100%' }}>
      {data.map((d, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end' }}>
            <div
              style={{
                width: '100%',
                height: `${(d.value / max) * 100}%`,
                minHeight: 4,
                background: d.color || color,
                borderRadius: '4px 4px 0 0',
                opacity: d.dim ? 0.4 : 1,
              }}
              title={`${d.label}: ${d.value}`}
            />
          </div>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: 'rgba(255,255,255,.5)',
              letterSpacing: '-0.01em',
            }}
          >
            {d.label}
          </div>
        </div>
      ))}
    </div>
  )
}
