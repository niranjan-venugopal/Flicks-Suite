'use client'

interface SparklineProps {
  data: number[]
  color?: string
  w?: number
  h?: number
  fill?: boolean
}

export function Sparkline({
  data,
  color = '#3E7BFA',
  w = 120,
  h = 32,
  fill = true,
}: SparklineProps) {
  if (data.length === 0) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const rg = Math.max(max - min, 1)
  const pts = data.map<[number, number]>((v, i) => [
    i * (w / Math.max(data.length - 1, 1)),
    h - ((v - min) / rg) * (h - 4) - 2,
  ])
  const d = 'M' + pts.map((p) => p.join(' ')).join(' L')

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      {fill && <path d={`${d} L${w} ${h} L0 ${h} Z`} fill={color} fillOpacity=".12" />}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
