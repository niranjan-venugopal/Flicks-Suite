import { cn } from '@/lib/utils'

type StatusType =
  | 'active'
  | 'inactive'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'present'
  | 'absent'
  | 'late'
  | 'on_leave'
  | 'remote'
  | 'draft'
  | 'submitted'
  | 'processing'
  | string

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'border-brand-green/30 bg-brand-green/15 text-brand-green' },
  inactive: { label: 'Inactive', className: 'border-white/20 bg-white/5 text-white/50' },
  pending: { label: 'Pending', className: 'border-brand-yellow/30 bg-brand-yellow/15 text-brand-yellow' },
  approved: { label: 'Approved', className: 'border-brand-green/30 bg-brand-green/15 text-brand-green' },
  rejected: { label: 'Rejected', className: 'border-brand-coral/30 bg-brand-coral/15 text-brand-coral' },
  present: { label: 'Present', className: 'border-brand-green/30 bg-brand-green/15 text-brand-green' },
  absent: { label: 'Absent', className: 'border-brand-coral/30 bg-brand-coral/15 text-brand-coral' },
  late: { label: 'Late', className: 'border-brand-yellow/30 bg-brand-yellow/15 text-brand-yellow' },
  on_leave: { label: 'On Leave', className: 'border-brand-blue/30 bg-brand-blue/15 text-brand-blue' },
  remote: { label: 'Remote', className: 'border-purple-400/30 bg-purple-400/15 text-purple-400' },
  draft: { label: 'Draft', className: 'border-white/20 bg-white/5 text-white/50' },
  submitted: { label: 'Submitted', className: 'border-brand-blue/30 bg-brand-blue/15 text-brand-blue' },
  processing: { label: 'Processing', className: 'border-brand-yellow/30 bg-brand-yellow/15 text-brand-yellow' },
}

interface StatusBadgeProps {
  status: StatusType
  className?: string
  customLabel?: string
}

export function StatusBadge({ status, className, customLabel }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
    className: 'border-white/20 bg-white/5 text-white/60',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-semibold font-gilroy',
        config.className,
        className
      )}
    >
      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {customLabel ?? config.label}
    </span>
  )
}
