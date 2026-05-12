import { cn } from '@/lib/utils'

interface PageGlowsProps {
  variant?: 'default' | 'auth' | 'minimal'
  className?: string
}

/**
 * Ambient glow blobs behind page content. Uses the .glow + tone classes
 * defined in globals.css (ported from prototype tokens).
 */
export function PageGlows({ variant = 'default', className }: PageGlowsProps) {
  return (
    <div className={cn('fixed inset-0 pointer-events-none overflow-hidden', className)}>
      {variant === 'auth' && (
        <>
          <div
            className="glow glow-blue"
            style={{ top: -200, left: -150, width: 600, height: 600 }}
          />
          <div
            className="glow glow-coral"
            style={{ bottom: -200, right: -150, width: 500, height: 500 }}
          />
          <div
            className="glow glow-purple"
            style={{ top: '30%', right: '20%', width: 400, height: 400 }}
          />
        </>
      )}
      {variant === 'default' && (
        <>
          <div
            className="glow glow-blue"
            style={{ top: -150, left: -100, width: 500, height: 500 }}
          />
          <div
            className="glow glow-coral"
            style={{ bottom: -200, right: -100, width: 500, height: 500 }}
          />
          <div
            className="glow glow-yellow"
            style={{ top: '40%', right: '30%', width: 300, height: 300 }}
          />
        </>
      )}
      {variant === 'minimal' && (
        <div
          className="glow glow-blue"
          style={{ top: -200, right: -100, width: 600, height: 600 }}
        />
      )}
    </div>
  )
}
