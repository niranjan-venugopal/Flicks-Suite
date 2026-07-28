'use client'

import * as React from 'react'
import type { ToastActionElement, ToastProps } from '@/components/ui/toast'

const TOAST_LIMIT = 1
const TOAST_REMOVE_DELAY = 1000000

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
  /** Leading glyph (status dot, check, warn) rendered in the pill. */
  icon?: React.ReactNode
  /**
   * Undo affordance (catalog: "undo > confirm"). When present the toast shows
   * an Undo button and a 5s linear draining bar, then auto-dismisses.
   */
  undo?: { onUndo: () => void; label?: string }
}

const actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
} as const

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

type ActionType = typeof actionTypes

type Action =
  | {
      type: ActionType['ADD_TOAST']
      toast: ToasterToast
    }
  | {
      type: ActionType['UPDATE_TOAST']
      toast: Partial<ToasterToast>
    }
  | {
      type: ActionType['DISMISS_TOAST']
      toastId?: ToasterToast['id']
    }
  | {
      type: ActionType['REMOVE_TOAST']
      toastId?: ToasterToast['id']
    }

interface State {
  toasts: ToasterToast[]
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId)
    dispatch({
      type: 'REMOVE_TOAST',
      toastId: toastId,
    })
  }, TOAST_REMOVE_DELAY)

  toastTimeouts.set(toastId, timeout)
}

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      }
    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      }
    case 'DISMISS_TOAST': {
      const { toastId } = action
      if (toastId) {
        addToRemoveQueue(toastId)
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      }
    }
    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        }
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      }
  }
}

const listeners: Array<(state: State) => void> = []

let memoryState: State = { toasts: [] }

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => {
    listener(memoryState)
  })
}

type Toast = Omit<ToasterToast, 'id'>

/** Undo window in ms — must match the draining bar animation in Toaster. */
export const UNDO_MS = 5000

function toast({ ...props }: Toast) {
  const id = genId()

  // PRD v4 §5 — Do Not Disturb suppresses NON-CRITICAL toasts. Destructive
  // (errors/security) always surface; the bell/inbox continue to accrue
  // regardless. Lazy require avoids a hook/store import cycle at module load.
  if (props.variant !== 'destructive') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isSelfDnd } = require('@/lib/presence/presence-store') as {
        isSelfDnd: () => boolean
      }
      if (isSelfDnd()) {
        return { id, dismiss: () => {}, update: () => {} }
      }
    } catch {
      /* presence store not available (public pages) — show normally */
    }
  }

  const update = (props: ToasterToast) =>
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { ...props, id },
    })
  const dismiss = () => dispatch({ type: 'DISMISS_TOAST', toastId: id })

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  return {
    id: id,
    dismiss,
    update,
  }
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }, [state])

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: 'DISMISS_TOAST', toastId }),
  }
}

/**
 * Reversible action feedback: one line, an Undo button and a 5s draining bar.
 * Prefer this over a confirm dialog for anything that can be taken back —
 * confirms are reserved for destructive, cross-user actions.
 */
function toastUndo(opts: {
  title: string
  onUndo: () => void
  icon?: React.ReactNode
  label?: string
}) {
  return toast({
    title: opts.title,
    icon: opts.icon,
    undo: { onUndo: opts.onUndo, label: opts.label ?? 'Undo' },
    duration: UNDO_MS,
  })
}

export { useToast, toast, toastUndo }
