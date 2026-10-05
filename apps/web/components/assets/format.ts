import { formatDate } from '@/lib/utils'
import type { Asset } from '@/lib/api/queries/use-assets'

/** Date-only strings ('2026-01-05') are parsed as local midnight so they never shift a day in IST. */
export function fmtAssetDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : formatDate(d)
}

/** "Dell · Latitude 5440" — brand and model when present, else ''. */
export function assetMake(a: Pick<Asset, 'brand' | 'model'>): string {
  return [a.brand, a.model].filter(Boolean).join(' · ')
}

/** Today as the house YYYY-MM-DD (local clock). */
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
