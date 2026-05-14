import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string, format = 'DD MMM YYYY'): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function maskPAN(pan: string): string {
  if (!pan || pan.length < 4) return pan
  return '••••••' + pan.slice(-4)
}

export function maskAccount(account: string): string {
  if (!account || account.length < 4) return account
  return '••••' + account.slice(-4)
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

export function getInitials(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return 'U'
  const trimmed = name.trim()
  if (!trimmed) return 'U'
  return trimmed
    .split(/\s+/)
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U'
}

export function formatCurrency(amount: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

/** Compact relative time for notification rows ("3m", "2h", "5d", "Apr 12"). */
export function timeAgo(input: Date | string | null | undefined): string {
  if (!input) return ''
  const date = typeof input === 'string' ? new Date(input) : input
  const diff = Math.max(0, Date.now() - date.getTime())
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
