import { cn } from '@/lib/utils'

interface PageGlowsProps {
  variant?: 'default' | 'auth' | 'minimal'
  className?: string
}

export function PageGlows({ variant = 'default', className }: PageGlowsProps) {
  return (
    <div className={cn('fixed inset-0 pointer-events-none overflow-hidden', className)}>
      {variant === 'auth' && (
        <>
          <div
            className="glow-blob animate-float-slow"
            style={{
              width: '600px',
              height: '600px',
              background: '#2B69F5',
              top: '-200px',
              left: '-200px',
              opacity: 0.12,
            }}
          />
          <div
            className="glow-blob animate-float-medium"
            style={{
              width: '400px',
              height: '400px',
              background: '#00C9A7',
              bottom: '-100px',
              right: '-100px',
              opacity: 0.08,
              animationDelay: '2s',
            }}
          />
          <div
            className="glow-blob animate-float-slow"
            style={{
              width: '300px',
              height: '300px',
              background: '#FFC72C',
              top: '50%',
              right: '20%',
              opacity: 0.06,
              animationDelay: '4s',
            }}
          />
        </>
      )}
      {variant === 'default' && (
        <>
          <div
            className="glow-blob"
            style={{
              width: '800px',
              height: '800px',
              background: '#2B69F5',
              top: '-300px',
              right: '-200px',
              opacity: 0.05,
            }}
          />
          <div
            className="glow-blob"
            style={{
              width: '500px',
              height: '500px',
              background: '#00C9A7',
              bottom: '-150px',
              left: '-100px',
              opacity: 0.04,
            }}
          />
        </>
      )}
      {variant === 'minimal' && (
        <div
          className="glow-blob"
          style={{
            width: '600px',
            height: '600px',
            background: '#2B69F5',
            top: '-200px',
            right: '-100px',
            opacity: 0.04,
          }}
        />
      )}
    </div>
  )
}
