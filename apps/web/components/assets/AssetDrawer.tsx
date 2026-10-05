'use client'

import { Avatar, Btn, Icon, Overlay, Pill } from '@/components/proto'
import { Skeleton } from '@/components/proto'
import { APIError } from '@/lib/api/client'
import {
  assetCategoryLabel,
  assetConditionMeta,
  assetStatusMeta,
  formatAssetValue,
  useAsset,
  type AssetDetail,
  type AssetHistoryRow,
} from '@/lib/api/queries/use-assets'
import { AssetThumb } from './AssetThumb'
import { assetMake, fmtAssetDate } from './format'

/**
 * Round P R4 — right-side detail panel for one asset: photo, every field,
 * who holds it (and whether they acknowledged), and the full assignment
 * history as a timeline. Actions (Assign / Return / Edit / Delete) are
 * callbacks — the register page owns the modals so one set serves the table
 * rows and the drawer alike. Built on the house Overlay (portal + scrim) with
 * the face pinned to the right edge; the modals sit at z 1000, above it.
 */

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="t-caption" style={{ fontSize: 10.5, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: mono ? 'var(--font-mono)' : undefined, wordBreak: 'break-word' }}>{value || '—'}</div>
    </div>
  )
}

function AckPill({ row }: { row: Pick<AssetHistoryRow, 'acknowledged_at' | 'returned_at'> }) {
  if (row.acknowledged_at) return <Pill tone="green" dot>Acknowledged {fmtAssetDate(row.acknowledged_at)}</Pill>
  if (row.returned_at) return <Pill>Not acknowledged</Pill>
  return <Pill tone="yellow" dot>Awaiting acknowledgement</Pill>
}

function HistoryItem({ row, open }: { row: AssetHistoryRow; open: boolean }) {
  const out = row.issue_condition ? assetConditionMeta(row.issue_condition).label : null
  const back = row.return_condition ? assetConditionMeta(row.return_condition).label : null
  return (
    <div style={{ position: 'relative', paddingLeft: 24, paddingBottom: 18 }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 4,
          width: 12,
          height: 12,
          borderRadius: 99,
          background: open ? 'var(--green)' : 'var(--surf-3)',
          border: open ? 'none' : '1.5px solid var(--bord-2)',
          boxShadow: '0 0 0 3px var(--surf-pop)',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Avatar name={row.employee_name} size="sm" src={row.employee_avatar_url ?? undefined} style={{ width: 20, height: 20, fontSize: 8 }} />
        <span style={{ fontSize: 13, fontWeight: 800 }}>{row.employee_name}</span>
        {row.employee_code && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)', fontWeight: 700 }}>{row.employee_code}</span>}
        {open ? <Pill tone="green" dot>Current</Pill> : null}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
        Issued {fmtAssetDate(row.assigned_at)}
        {row.assigned_by_name ? ` by ${row.assigned_by_name}` : ''}
        {out ? ` · ${out}` : ''}
        {row.notes ? <div style={{ color: 'var(--text-mute)' }}>“{row.notes}”</div> : null}
      </div>
      {row.returned_at && (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginTop: 2, lineHeight: 1.5 }}>
          Returned {fmtAssetDate(row.returned_at)}
          {row.returned_by_name ? ` to ${row.returned_by_name}` : ''}
          {back ? ` · ${back}` : ''}
          {row.return_notes ? <div style={{ color: 'var(--text-mute)' }}>“{row.return_notes}”</div> : null}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <AckPill row={row} />
      </div>
    </div>
  )
}

export function AssetDrawer({
  assetId,
  onClose,
  canManage = true,
  onAssign,
  onReturn,
  onEdit,
  onDelete,
}: {
  assetId: string | null
  onClose: () => void
  canManage?: boolean
  onAssign: (asset: AssetDetail) => void
  onReturn: (asset: AssetDetail) => void
  onEdit: (asset: AssetDetail) => void
  onDelete: (asset: AssetDetail) => void
}) {
  const q = useAsset(assetId)
  const a = q.data?.data ?? null
  const status = a ? assetStatusMeta(a.status) : null
  const cond = a ? assetConditionMeta(a.condition) : null
  const holder = a?.current_assignment ?? null
  const assignable = !!a && !holder && a.status !== 'retired' && a.status !== 'lost'
  const gone = q.error instanceof APIError && (q.error.status === 404 || q.error.status === 403)

  return (
    <Overlay open={!!assetId} onClose={onClose} zIndex={950} blur={0} dim={0.35} padding={0} label="Asset details">
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="asset-drawer"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(560px, 100vw)',
          background: 'var(--surf-pop)',
          borderLeft: '1px solid var(--bord-2)',
          boxShadow: 'var(--e3)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'pmfade .12s ease-out',
        }}
      >
        {/* Head */}
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--bord)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {a ? (
            <>
              <AssetThumb src={a.photo_thumb_url} category={a.category} name={a.name} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 800, color: 'var(--text-mute)' }}>{a.asset_tag}</span>
                  {status && <Pill tone={status.tone} dot>{status.label}</Pill>}
                </div>
                <div className="t-h3" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
              </div>
            </>
          ) : (
            <div style={{ flex: 1 }}>
              <Skeleton w={120} h={12} style={{ marginBottom: 8 }} />
              <Skeleton w={220} h={16} />
            </div>
          )}
          <Btn kind="ghost" size="sm" icon={<Icon.x size={16} />} onClick={onClose} aria-label="Close" />
        </div>

        {/* Body */}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '18px 22px 28px' }}>
          {q.isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Skeleton h={160} r={14} />
              <Skeleton w="60%" h={12} />
              <Skeleton w="40%" h={12} />
              <Skeleton w="70%" h={12} />
            </div>
          ) : q.isError || !a ? (
            <div style={{ textAlign: 'center', padding: '30px 10px' }}>
              <Icon.warn size={20} style={{ color: 'var(--coral)', marginBottom: 8 }} />
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>
                {gone ? 'This asset is no longer available' : 'Could not load this asset'}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', marginBottom: 12 }}>
                {gone ? 'It may have been deleted, or you no longer have access.' : q.error instanceof Error ? q.error.message : 'Try again.'}
              </div>
              {!gone && (
                <Btn kind="secondary" size="sm" icon={<Icon.refresh size={12} />} onClick={() => void q.refetch()}>
                  Retry
                </Btn>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {canManage && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {holder ? (
                    <Btn kind="primary" size="sm" icon={<Icon.swap size={13} />} onClick={() => onReturn(a)} data-testid="drawer-return">
                      Record return
                    </Btn>
                  ) : assignable ? (
                    <Btn kind="primary" size="sm" icon={<Icon.userPlus size={13} />} onClick={() => onAssign(a)} data-testid="drawer-assign">
                      Assign
                    </Btn>
                  ) : null}
                  <Btn kind="secondary" size="sm" icon={<Icon.edit size={13} />} onClick={() => onEdit(a)}>
                    Edit
                  </Btn>
                  <span style={{ flex: 1 }} />
                  <Btn kind="ghost" size="sm" icon={<Icon.trash size={13} />} onClick={() => onDelete(a)} disabled={!!holder} title={holder ? 'Return the asset first' : undefined} style={{ color: 'var(--coral)' }}>
                    Delete
                  </Btn>
                </div>
              )}

              {a.photo_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.photo_url}
                  alt={a.name}
                  style={{ width: '100%', maxHeight: 260, objectFit: 'contain', borderRadius: 14, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}
                />
              )}

              {/* Holder */}
              <div className="card" style={{ padding: 14, background: 'var(--surf-1)' }}>
                {holder ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Avatar name={holder.employee_name} size="md" src={holder.employee_avatar_url ?? undefined} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>
                        {holder.employee_name}
                        {holder.employee_code && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', fontWeight: 700, marginLeft: 8, fontSize: 11 }}>{holder.employee_code}</span>}
                      </div>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                        Issued {fmtAssetDate(holder.assigned_at)}
                        {holder.assigned_by_name ? ` by ${holder.assigned_by_name}` : ''}
                        {holder.issue_condition ? ` · ${assetConditionMeta(holder.issue_condition).label}` : ''}
                      </div>
                    </div>
                    <AckPill row={{ acknowledged_at: holder.acknowledged_at, returned_at: null }} />
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>
                    <Icon.user size={15} style={{ color: 'var(--text-faint)' }} />
                    Nobody holds this right now — {status?.label.toLowerCase()}.
                  </div>
                )}
              </div>

              {/* Facts */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Row label="Category" value={assetCategoryLabel(a.category)} />
                <Row label="Condition" value={cond ? <Pill tone={cond.tone}>{cond.label}</Pill> : '—'} />
                <Row label="Brand · model" value={assetMake(a)} />
                <Row label="Serial number" value={a.serial_number} mono />
                <Row label="Purchased" value={fmtAssetDate(a.purchase_date)} />
                <Row label="Value" value={formatAssetValue(a.purchase_value, a.currency)} />
                <Row label="Added" value={fmtAssetDate(a.created_at)} />
                <Row label="Last updated" value={fmtAssetDate(a.updated_at)} />
                {a.notes && (
                  <div style={{ gridColumn: 'span 2' }}>
                    <Row label="Notes" value={<span style={{ whiteSpace: 'pre-wrap', fontWeight: 600, color: 'var(--text-2)' }}>{a.notes}</span>} />
                  </div>
                )}
              </div>

              {/* History */}
              <div>
                <div className="t-caption" style={{ marginBottom: 12 }}>History · {a.history.length}</div>
                {a.history.length === 0 ? (
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-mute)' }}>Never assigned yet.</div>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 5.5, top: 10, bottom: 18, width: 1.5, background: 'var(--bord-2)' }} />
                    {a.history.map((row) => (
                      <HistoryItem key={row.id} row={row} open={!row.returned_at} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  )
}
