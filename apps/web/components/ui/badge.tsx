import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-2.5 py-0.5 text-xs font-semibold font-gilroy transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        // Paler tint on the light page so the accent text keeps ~4.5:1; dark keeps /20.
        default: 'border-brand-blue/30 bg-brand-blue/10 dark:bg-brand-blue/20 text-brand-blue',
        secondary: 'border-ink/10 bg-ink/10 text-ink/70',
        destructive: 'border-brand-coral/30 bg-brand-coral/10 dark:bg-brand-coral/20 text-brand-coral',
        success: 'border-brand-green/30 bg-brand-green/10 dark:bg-brand-green/20 text-brand-green',
        warning: 'border-brand-yellow/30 bg-brand-yellow/10 dark:bg-brand-yellow/20 text-brand-yellow',
        outline: 'border-ink/20 text-ink/70',
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
