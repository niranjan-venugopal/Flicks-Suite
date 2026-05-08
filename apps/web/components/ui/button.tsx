import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-gilroy font-semibold text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-brand-blue text-white hover:bg-blue-600 shadow-glow-blue hover:shadow-lg',
        destructive:
          'bg-brand-coral text-white hover:bg-red-600 shadow-glow-coral',
        outline:
          'border border-white/10 bg-white/5 text-white hover:bg-white/10 hover:border-white/20',
        secondary:
          'bg-white/10 text-white hover:bg-white/15',
        ghost:
          'text-white/70 hover:text-white hover:bg-white/5',
        link:
          'text-brand-blue underline-offset-4 hover:underline',
        success:
          'bg-brand-green text-white hover:bg-emerald-600 shadow-glow-green',
        warning:
          'bg-brand-yellow text-gray-900 hover:bg-yellow-400 shadow-glow-yellow',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-12 px-8 text-base',
        xl: 'h-14 px-10 text-lg',
        icon: 'h-9 w-9',
        'icon-sm': 'h-7 w-7',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
