import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-10 w-full rounded border border-ink/10 bg-ink/5 px-3 py-2 text-sm text-ink font-gilroy placeholder:text-ink/30 transition-all duration-200',
          'focus:outline-none focus:border-brand-blue/60 focus:bg-ink/8 focus:ring-1 focus:ring-brand-blue/30',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
