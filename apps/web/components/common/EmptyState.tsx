import { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-16 px-4 text-center',
        className
      )}
    >
      {Icon && (
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-ink/5 border border-ink/10">
          <Icon className="h-7 w-7 text-ink/30" />
        </div>
      )}
      <h3 className="text-base font-semibold text-ink/70 font-gilroy mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-ink/40 font-gilroy max-w-sm">{description}</p>
      )}
      {action && (
        <Button onClick={action.onClick} variant="outline" size="sm" className="mt-4">
          {action.label}
        </Button>
      )}
    </div>
  )
}
