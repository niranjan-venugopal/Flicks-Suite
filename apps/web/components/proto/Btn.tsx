'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger'
export type BtnSize = '' | 'sm'

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  kind?: BtnKind
  size?: BtnSize
  icon?: ReactNode
  iconRight?: ReactNode
  children?: ReactNode
}

// Btn — port of the prototype's <Btn> with kind/size/icon/iconRight props.
// Children omitted = renders as an icon-only square button.
export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { kind = 'secondary', size = '', icon, iconRight, children, type = 'button', className = '', ...rest },
  ref,
) {
  const isIconOnly = !children
  const cls =
    `btn btn-${kind}` +
    (size ? ` btn-${size}` : '') +
    (isIconOnly ? ' btn-icon' : '') +
    (className ? ' ' + className : '')

  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {icon}
      {children}
      {iconRight}
    </button>
  )
})
