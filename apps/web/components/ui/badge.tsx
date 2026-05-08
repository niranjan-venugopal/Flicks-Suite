import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-2.5 py-0.5 text-xs font-semibold font-gilroy transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-brand-blue/30 bg-brand-blue/20 text-brand-blue',
        secondary: 'border-white/10 bg-white/10 text-white/70',
        destructive: 'border-brand-coral/30 bg-brand-coral/20 text-brand-coral',
        success: 'border-brand-green/30 bg-brand-green/20 text-brand-green',
        warning: 'border-brand-yellow/30 bg-brand-yellow/20 text-brand-yellow',
        outline: 'border-white/20 text-white/70',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
