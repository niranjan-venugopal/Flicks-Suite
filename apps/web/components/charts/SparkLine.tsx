'use client'

import { ResponsiveContainer, LineChart, Line, Tooltip } from 'recharts'
import { cn } from '@/lib/utils'

interface SparkLineProps {
  data: Array<{ value: number; label?: string }>
  color?: string
  height?: number
  className?: string
  showTooltip?: boolean
}

export function SparkLine({
  data,
  color = '#2B69F5',
  height = 40,
  className,
  showTooltip = false,
}: SparkLineProps) {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
            activeDot={showTooltip ? { r: 3, fill: color } : false}
          />
          {showTooltip && (
            <Tooltip
              contentStyle={{
                background: 'rgba(0,0,0,0.8)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: 'white',
                fontSize: '12px',
                fontFamily: 'Gilroy',
              }}
              formatter={(value: number) => [value, '']}
              labelFormatter={() => ''}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
