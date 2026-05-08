'use client'

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { cn } from '@/lib/utils'

interface DonutChartSegment {
  name: string
  value: number
  color: string
}

interface DonutChartProps {
  data: DonutChartSegment[]
  size?: number
  innerRadius?: number
  outerRadius?: number
  className?: string
  centerLabel?: string
  centerSubLabel?: string
}

export function DonutChart({
  data,
  size = 120,
  innerRadius = 35,
  outerRadius = 50,
  className,
  centerLabel,
  centerSubLabel,
}: DonutChartProps) {
  return (
    <div className={cn('relative', className)} style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            dataKey="value"
            strokeWidth={0}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: 'rgba(0,0,0,0.85)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: 'white',
              fontSize: '12px',
              fontFamily: 'Gilroy',
            }}
            formatter={(value: number, name: string) => [value, name]}
          />
        </PieChart>
      </ResponsiveContainer>
      {(centerLabel || centerSubLabel) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          {centerLabel && (
            <span className="text-lg font-bold text-white font-gilroy leading-none">
              {centerLabel}
            </span>
          )}
          {centerSubLabel && (
            <span className="text-xs text-white/50 font-gilroy mt-0.5">
              {centerSubLabel}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
