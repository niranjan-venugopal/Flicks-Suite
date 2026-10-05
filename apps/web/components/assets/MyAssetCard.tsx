'use client'

import { Btn, Icon, Pill } from '@/components/proto'
import { assetCategoryLabel, assetConditionMeta, type MyAsset } from '@/lib/api/queries/use-assets'
import { formatDate } from '@/lib/utils'
import { AssetThumb } from './AssetThumb'

/**
 * Round P R4 — one piece of equipment on the employee's "My assets" page.
 * Photo (or the category glyph), name, tag, serial, make, who issued it and
 * when, the condition it was issued in, HR's note, and the acknowledgement
 * state: a card still to be acknowledged carries a coral "Please acknowledge"
 * pill and the primary "Acknowledge receipt" button; an acknowledged one
 * shows the date in green. Pure presentation — the page owns the mutation.
 */
export function MyAssetCard({
  item,
  onAcknowledge,
  acknowledging = false,
}: {
  item: MyAsset
  onAcknowledge: (assetId: string) => void
  acknowledging?: boolean
}) {
  const { asset, assignment } = item
  const pending = !assignment.acknowledged_at
  const condition = assetConditionMeta(assignment.issue_condition ?? asset.condition)
  const make = [asset.brand, asset.model].filter(Boolean).join(' · ')
  // The issue note is written for the holder; the register note only shows
  // when it says something different (HR often repeats "charger + bag" in both).
  const notes = [assignment.notes, asset.notes]
    .map((n) => n?.trim() ?? '')
    .filter((n, i, all) => n && all.indexOf(n) === i)

  return (
    <div
      className="card"
      data-testid={`my-asset-card-${pending ? 'pending' : 'acknowledged'}`}
      data-asset-id={asset.id}
      style={{
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        borderColor: pending ? 'color-mix(in srgb, var(--coral) 35%, var(--bord))' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <AssetThumb src={asset.photo_url} category={asset.category} name={asset.name} size={84} radius={14} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: '-0.01em',
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {asset.name}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              marginTop: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--text-mute)',
            }}
          >
            <span
              data-testid="my-asset-tag"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)', letterSpacing: '0.01em' }}
            >
              {asset.asset_tag}
            </span>
            <span>· {assetCategoryLabel(asset.category)}</span>
          </div>
          <dl
            style={{
              margin: '10px 0 0',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 10,
              rowGap: 3,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-2)',
            }}
          >
            {asset.serial_number && (
              <>
                <dt style={{ color: 'var(--text-mute)' }}>Serial</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, wordBreak: 'break-all' }}>
                  {asset.serial_number}
                </dd>
              </>
            )}
            {make && (
              <>
                <dt style={{ color: 'var(--text-mute)' }}>Make</dt>
                <dd style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {make}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
          Issued on {formatDate(assignment.assigned_at)}
          {assignment.assigned_by_name ? ` by ${assignment.assigned_by_name}` : ''}
        </span>
        <Pill tone={condition.tone} style={{ marginLeft: 'auto' }}>
          {condition.label} condition
        </Pill>
      </div>

      {notes.length > 0 && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-mute)',
            lineHeight: 1.5,
            padding: '9px 12px',
            borderRadius: 9,
            background: 'var(--surf-2)',
            border: '1px solid var(--bord)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {notes.map((n, i) => (
            <div key={i} style={{ marginTop: i ? 6 : 0 }}>
              {n}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginTop: 'auto',
          paddingTop: 2,
        }}
      >
        {pending ? (
          <>
            <Pill tone="coral" dot>
              Please acknowledge
            </Pill>
            <Btn
              kind="primary"
              size="sm"
              data-testid="my-asset-acknowledge"
              disabled={acknowledging}
              onClick={() => onAcknowledge(asset.id)}
              icon={<Icon.check size={12} />}
            >
              {acknowledging ? 'Recording…' : 'Acknowledge receipt'}
            </Btn>
          </>
        ) : (
          <Pill tone="green" icon={<Icon.check size={11} />}>
            Acknowledged on {formatDate(assignment.acknowledged_at!)}
          </Pill>
        )}
      </div>
    </div>
  )
}
