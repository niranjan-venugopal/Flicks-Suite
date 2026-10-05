'use client'

import { useState } from 'react'
import { Avatar, Btn, Icon, Modal } from '@/components/proto'
import { useToast } from '@/components/ui/use-toast'
import {
  ASSET_CONDITIONS,
  ASSET_STATUSES,
  assetStatusMeta,
  useReturnAsset,
  type Asset,
  type AssetCondition,
  type AssetDetail,
  type AssetStatus,
} from '@/lib/api/queries/use-assets'
import { AssetThumb } from './AssetThumb'
import { fmtAssetDate } from './format'

/**
 * Round P R4 — record a return: the condition it came back in, where it goes
 * next (in stock by default; under repair / retired / lost when it is not
 * coming back into circulation) and notes. Used from the register, the
 * drawer, the employee 360 tab and the offboarding dialog.
 */

type NextStatus = Exclude<AssetStatus, 'assigned'>
const NEXT_STATUSES = ASSET_STATUSES.filter((s): s is (typeof ASSET_STATUSES)[number] & { value: NextStatus } => s.value !== 'assigned')

/** The minimum an asset row needs for the return form (register rows and 360-tab rows both qualify). */
export type ReturnableAsset = Pick<Asset, 'id' | 'asset_tag' | 'name' | 'category' | 'condition' | 'photo_thumb_url'> & {
  current_assignment?: Pick<NonNullable<Asset['current_assignment']>, 'employee_name' | 'employee_avatar_url' | 'assigned_at'> | null
}

export function ReturnAssetModal({
  open,
  onClose,
  asset,
  onReturned,
}: {
  open: boolean
  onClose: () => void
  asset: ReturnableAsset | null
  onReturned?: (detail: AssetDetail) => void
}) {
  const { toast } = useToast()
  const ret = useReturnAsset()
  const [condition, setCondition] = useState<AssetCondition>(asset?.condition ?? 'good')
  const [next, setNext] = useState<NextStatus>('in_stock')
  const [notes, setNotes] = useState('')

  // Reset during render on open / asset change (see AssetFormModal for why not an effect).
  const [prevKey, setPrevKey] = useState<string | null>(null)
  const key = open ? (asset?.id ?? '') : null
  if (key !== prevKey) {
    setPrevKey(key)
    if (key !== null) {
      setCondition(asset?.condition ?? 'good')
      setNext('in_stock')
      setNotes('')
    }
  }

  const submit = async () => {
    if (!asset) return
    try {
      const res = await ret.mutateAsync({
        id: asset.id,
        payload: { return_condition: condition, next_status: next, return_notes: notes.trim() || null },
      })
      toast({
        title: `${asset.asset_tag} returned`,
        description: `Now ${assetStatusMeta(next).label.toLowerCase()} · condition ${condition}.`,
      })
      onReturned?.(res.data)
      onClose()
    } catch (err) {
      toast({
        title: 'Could not record the return',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const holder = asset?.current_assignment ?? null

  return (
    <Modal
      open={open}
      onClose={ret.isPending ? () => {} : onClose}
      title={`Return ${asset?.asset_tag ?? ''}`}
      sub={asset?.name}
      width={500}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={ret.isPending}>
            Cancel
          </Btn>
          <Btn kind="primary" icon={<Icon.check size={14} />} onClick={() => void submit()} disabled={ret.isPending || !asset} data-testid="return-submit">
            {ret.isPending ? 'Saving…' : 'Record return'}
          </Btn>
        </>
      }
    >
      {asset && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}>
            <AssetThumb src={asset.photo_thumb_url} category={asset.category} name={asset.name} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', marginRight: 8 }}>{asset.asset_tag}</span>
                {asset.name}
              </div>
              {holder && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4, fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }}>
                  <Avatar name={holder.employee_name} size="sm" src={holder.employee_avatar_url ?? undefined} style={{ width: 18, height: 18, fontSize: 7 }} />
                  Held by {holder.employee_name} since {fmtAssetDate(holder.assigned_at)}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label className="label">Condition on return</label>
              <select className="input" value={condition} onChange={(e) => setCondition(e.target.value as AssetCondition)} data-testid="return-condition">
                {ASSET_CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">What happens next</label>
              <select className="input" value={next} onChange={(e) => setNext(e.target.value as NextStatus)} data-testid="return-next">
                {NEXT_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label className="label">Notes</label>
              <textarea
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Charger missing, scratch on the lid, wiped and reset…"
                style={{ height: 'auto', resize: 'vertical', paddingTop: 9, paddingBottom: 9 }}
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
