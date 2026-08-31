'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    {/*
      Centering strategy: a fixed full-viewport flex container holds the
      content card. This is immune to ancestor containing blocks (which
      `transform`, `filter`, and `backdrop-filter` create — the Topbar uses
      backdrop-filter, so the old `top:50% + translate-y:-50%` approach was
      computed against the wrong containing block in some viewports and the
      dialog ended up below the fold).
    */}
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      )}
      {...props}
    >
      {/*
        Close-button contract (founder round A): the X is pinned to the CARD,
        not the scroll region — on a tall dialog it used to scroll out of
        view — sits on the p-6 (24px) gutter instead of 8px inside it, and is
        vertically centred on the title's line (text-lg ⇒ 28px line at 24px
        top padding ⇒ centreline 38px; the 24px hit box starts at 26px).
        Consumer classNames are width-only (audited), so moving padding+scroll
        to the inner region is invisible to all 25 call sites.
      */}
      <div
        className={cn(
          // modal-card: opaque face — the glass recipe nested inside the
          // overlay's backdrop-blur composites unreliably and disappears on
          // near-black pages (founder round D).
          'relative pointer-events-auto flex w-full max-w-lg flex-col glass modal-card rounded-md border border-white/10 shadow-xl',
          'max-h-[90vh]',
          className,
        )}
      >
        <div className="grid gap-4 overflow-y-auto p-6">{children}</div>
        <DialogPrimitive.Close className="absolute right-5 top-[26px] rounded-sm p-1 opacity-50 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/30 disabled:pointer-events-none">
          <X className="h-4 w-4 text-white" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // pr-8 reserves the close button's column so a long title truncates
    // beside the X instead of running underneath it.
    className={cn('flex flex-col space-y-1.5 pr-8 text-left', className)}
    {...props}
  />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-white font-gilroy', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-white/50 font-gilroy', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
