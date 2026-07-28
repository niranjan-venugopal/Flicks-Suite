'use client'

import {
  Toast,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast'
import { useToast, UNDO_MS } from '@/components/ui/use-toast'

/**
 * Toast host — catalog spec: bottom-center, ONE at a time, pill-shaped,
 * slide-up 160ms ease-out. Reversible actions carry an Undo button plus a
 * 5s linear draining bar; ⌘Z keeps working independently of the toast.
 */
export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider swipeDirection="down">
      {toasts.map(function ({ id, title, description, action, icon, undo, ...props }) {
        return (
          <Toast key={id} {...props}>
            {icon && <span className="flex shrink-0 items-center">{icon}</span>}
            <div className="flex min-w-0 flex-col">
              {title && <ToastTitle className="text-[11.5px] font-extrabold">{title}</ToastTitle>}
              {description && (
                <ToastDescription className="text-[10.5px] opacity-70">
                  {description}
                </ToastDescription>
              )}
            </div>
            {undo ? (
              <button
                type="button"
                onClick={() => {
                  undo.onUndo()
                  props.onOpenChange?.(false)
                }}
                className="shrink-0 text-[11px] font-extrabold text-brand-blue hover:underline"
              >
                {undo.label ?? 'Undo'}
              </button>
            ) : (
              action
            )}
            {undo && (
              // Draining bar: 100% → 0 over the undo window, linear.
              <span
                aria-hidden
                className="absolute bottom-0 left-0 h-[2px] bg-brand-blue"
                style={{ animation: `pmundo ${UNDO_MS}ms linear forwards` }}
              />
            )}
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
