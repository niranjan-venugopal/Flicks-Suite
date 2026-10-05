'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Btn, Icon, Pill, Skeleton } from '@/components/proto'
import { APIError } from '@/lib/api/client'
import { useAuthStore } from '@/lib/stores/auth.store'
import {
  assetConditionMeta,
  useEmployeeAssets,
  type Asset,
} from '@/lib/api/queries/use-assets'
import { AssetThumb } from './AssetThumb'
import { ReturnAssetModal } from './ReturnAssetModal'
import { assetMake, fmtAssetDate } from './format'

/**
 * Round P R4 — Employee 360 → Assets. What the person holds now (with
 * Return right there), what they returned before, and "Assign an asset",
 * which hands off to the register with ?assign=<employeeId> so the pick-an-
 * asset flow runs where the stock lives. GET /assets/by-employee is
 * admin-only, so a manager opening the 360 gets an honest lock line instead
 * of an error toast. Someone separated / absconded can still return things
 * but is never offered "Assign" (the server would refuse with a 400 anyway).
 */

export function EmployeeAssetsTab({
  employeeId,
  canAssign = true,
  cannotAssignReason,
}: {
  employeeId: string
  /** False for people who have left — hides "Assign an asset" with the reason. */
  canAssign?: boolean
  cannotAssignReason?: string
}) {
  const router = useRouter()
  const role = useAuthStore((s) => s.currentUser?.role)
  const canManage = role === 'OWNER' || role === 'HR_ADMIN' || role === 'FAM'
  const q = useEmployeeAssets(employeeId, canManage)
  const [returning, setReturning] = useState<Asset | null>(null)

  const goAssign = () => router.push(`/employees/assets?assign=${employeeId}`)
  const noAssignLine = cannotAssignReason ?? 'This person has left the company — nothing new can be issued.'

  if (!canManage) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
        <Icon.lock size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>Owners and admins only</div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
          Equipment records are managed by HR — ask an admin if something needs assigning or returning.
        </div>
      </div>
    )
  }

  const current = q.data?.data.current ?? []
  const history = q.data?.data.history ?? []
  const forbidden = q.error instanceof APIError && q.error.status === 403

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div className="t-h3" style={{ flex: 1 }}>
            Currently holding{q.isSuccess ? ` · ${current.length}` : ''}
          </div>
          {canAssign ? (
            <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={goAssign} data-testid="tab-assign-asset">
              Assign an asset
            </Btn>
          ) : (
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)' }} data-testid="tab-assign-blocked">
              {noAssignLine}
            </div>
          )}
        </div>

        {q.isLoading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {[0, 1].map((i) => (
              <div key={i} style={{ padding: 12, border: '1px solid var(--bord)', borderRadius: 12, display: 'flex', gap: 12 }}>
                <Skeleton w={48} h={48} r={10} />
                <div style={{ flex: 1 }}>
                  <Skeleton w="50%" h={12} style={{ marginBottom: 8 }} />
                  <Skeleton w="80%" h={10} />
                </div>
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <div style={{ padding: '18px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: forbidden ? 'var(--text-mute)' : 'var(--coral)', marginBottom: forbidden ? 0 : 10 }}>
              {forbidden ? 'Only owners and admins can see equipment records.' : 'Could not load equipment for this person.'}
            </div>
            {!forbidden && (
              <Btn kind="secondary" size="sm" icon={<Icon.refresh size={12} />} onClick={() => void q.refetch()}>
                Retry
              </Btn>
            )}
          </div>
        ) : current.length === 0 ? (
          <div style={{ border: '1px dashed var(--bord)', borderRadius: 10, padding: '22px 16px', textAlign: 'center' }}>
            <Icon.laptop size={20} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)', marginBottom: canAssign ? 10 : 0 }}>No equipment assigned</div>
            {canAssign && (
              <Btn kind="secondary" size="sm" onClick={goAssign}>
                Assign an asset
              </Btn>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }} data-testid="tab-current-assets">
            {current.map((a) => {
              const cond = assetConditionMeta(a.condition)
              const ack = a.current_assignment?.acknowledged_at
              return (
                <div key={a.id} style={{ padding: 12, border: '1px solid var(--bord)', borderRadius: 12, background: 'var(--surf-1)', display: 'flex', gap: 12 }}>
                  <AssetThumb src={a.photo_thumb_url} category={a.category} name={a.name} size={48} radius={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 800, color: 'var(--text-mute)' }}>{a.asset_tag}</span>
                      <span style={{ fontSize: 13, fontWeight: 800 }}>{a.name}</span>
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                      {assetMake(a) || '—'}
                      {a.serial_number ? ` · SN ${a.serial_number}` : ''}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', marginTop: 4 }}>
                      Issued {fmtAssetDate(a.current_assignment?.assigned_at)}
                      {a.current_assignment?.assigned_by_name ? ` by ${a.current_assignment.assigned_by_name}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Pill tone={cond.tone}>{cond.label}</Pill>
                      {ack ? <Pill tone="green" dot>Acknowledged</Pill> : <Pill tone="yellow" dot>Awaiting acknowledgement</Pill>}
                      <span style={{ flex: 1 }} />
                      <Btn kind="secondary" size="sm" icon={<Icon.swap size={12} />} onClick={() => setReturning(a)} data-testid="tab-return">
                        Return
                      </Btn>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {q.isSuccess && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="t-h3" style={{ padding: '18px 20px 12px' }}>
            Returned before · {history.length}
          </div>
          {history.length === 0 ? (
            <div style={{ padding: '0 20px 20px', fontSize: 12.5, fontWeight: 600, color: 'var(--text-mute)' }}>
              Nothing returned yet.
            </div>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Issued</th>
                    <th>Returned</th>
                    <th>Condition out → in</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <AssetThumb src={null} category={h.category} name={h.asset_name} size={28} radius={7} />
                          <div>
                            <div style={{ fontWeight: 800 }}>{h.asset_name}</div>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-mute)' }}>{h.asset_tag}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {fmtAssetDate(h.assigned_at)}
                        {h.assigned_by_name && <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>by {h.assigned_by_name}</div>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {fmtAssetDate(h.returned_at)}
                        {h.returned_by_name && <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>to {h.returned_by_name}</div>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {h.issue_condition ? assetConditionMeta(h.issue_condition).label : '—'} → {h.return_condition ? assetConditionMeta(h.return_condition).label : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-mute)', maxWidth: 260 }}>{h.return_notes || h.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <ReturnAssetModal open={!!returning} onClose={() => setReturning(null)} asset={returning} />
    </div>
  )
}
