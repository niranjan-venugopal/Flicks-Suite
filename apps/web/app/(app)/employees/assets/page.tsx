'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Avatar, Btn, Icon, Kpi, Pill, SectionHead } from '@/components/proto'
import { SkeletonCards, SkeletonRows } from '@/components/states'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useToast } from '@/components/ui/use-toast'
import { useAuthStore } from '@/lib/stores/auth.store'
import { APIError } from '@/lib/api/client'
import { useEmployee } from '@/lib/api/queries/use-employees'
import {
  ASSETS_PAGE_MAX,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  assetConditionMeta,
  assetStatusMeta,
  useAssets,
  useAssetsSummary,
  useDeleteAsset,
  useExportAssetsCsv,
  type Asset,
  type AssetCategory,
  type AssetDetail,
  type AssetStatus,
} from '@/lib/api/queries/use-assets'
import { AssetThumb } from '@/components/assets/AssetThumb'
import { AssetFormModal } from '@/components/assets/AssetFormModal'
import { AssignAssetModal } from '@/components/assets/AssignAssetModal'
import { ReturnAssetModal } from '@/components/assets/ReturnAssetModal'
import { AssetDrawer } from '@/components/assets/AssetDrawer'
import { assetMake, fmtAssetDate } from '@/components/assets/format'
import { useDebounced } from '@/components/assets/useDebounced'

/**
 * Round P R4 — People → Assets: the company equipment register. KPIs,
 * filters, the table with per-row Assign / Return / Edit / Delete, a
 * right-side detail drawer, CSV export, and the ?assign=<employeeId> entry
 * from the onboarding approval toast and the employee 360 ("pick an asset for
 * this person"; an empty register opens Add asset first, and the new asset
 * flows straight into the assignment).
 */

const SEARCH_DEBOUNCE_MS = 300

/** Something to assign: a fixed asset (row / drawer) and/or a fixed person (?assign=). */
interface AssignState {
  asset?: Asset | null
  employeeId?: string | null
}

interface FormState {
  asset?: Asset | AssetDetail | null
  note?: string
  /** After a create in the ?assign= flow, open Assign for this person with the new asset. */
  thenAssignTo?: string | null
}

function MenuItem({ onClick, danger, children, disabled, title }: { onClick: () => void; danger?: boolean; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 12.5,
        fontWeight: 700,
        color: disabled ? 'var(--text-faint)' : danger ? 'var(--coral)' : 'var(--text)',
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => !disabled && (e.currentTarget.style.background = 'var(--surf-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  )
}

export default function AssetsRegisterPage() {
  // useSearchParams() needs a Suspense boundary for Next's static export step.
  return (
    <Suspense fallback={null}>
      <AssetsRegisterInner />
    </Suspense>
  )
}

function AssetsRegisterInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const { toast } = useToast()
  const role = useAuthStore((s) => s.currentUser?.role)
  const canManage = role === 'OWNER' || role === 'HR_ADMIN' || role === 'FAM'

  const [status, setStatus] = useState<AssetStatus | ''>('')
  const [category, setCategory] = useState<AssetCategory | ''>('')
  const [q, setQ] = useState('')
  const dq = useDebounced(q, SEARCH_DEBOUNCE_MS)
  const filtersOn = !!status || !!category || !!dq.trim()

  const list = useAssets({ status, category, q: dq, limit: ASSETS_PAGE_MAX }, { enabled: canManage })
  const summary = useAssetsSummary(canManage)
  const exportCsv = useExportAssetsCsv()
  const del = useDeleteAsset()

  const [form, setForm] = useState<FormState | null>(null)
  const [assign, setAssign] = useState<AssignState | null>(null)
  const [returning, setReturning] = useState<Asset | null>(null)
  const [deleting, setDeleting] = useState<Asset | null>(null)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  // Which row's ⋯ menu is open — controlled so picking an item closes it
  // instead of leaving the popover behind the confirm dialog.
  const [menuRow, setMenuRow] = useState<string | null>(null)

  // ── ?assign=<employeeId> (onboarding toast, employee 360) ─────────────────
  // Needs the register's size to decide between "pick an asset" and "add the
  // first asset": wait for the (unfiltered) first load, then strip the param.
  const assignParam = sp.get('assign')
  const handledAssign = useRef<string | null>(null)
  const assignee = useEmployee(assignParam ?? '')
  useEffect(() => {
    if (!assignParam || !canManage || handledAssign.current === assignParam) return
    // Both lookups settled. An id we cannot resolve (another tenant, a typo,
    // a removed row) opens the flow with nobody pre-selected rather than
    // posting a bogus employee_id; someone who has left is pre-selected only
    // so the Assign modal can say why and ask for another person.
    if (!list.isSuccess || (!assignee.isSuccess && !assignee.isError)) return
    handledAssign.current = assignParam
    const person = assignee.data ?? null
    const name = person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || person.workEmail : null
    const left = !!person && (person.status === 'separated' || person.status === 'absconded')
    if ((list.data?.total ?? 0) === 0) {
      if (left) {
        toast({ title: `${name} has left the company`, description: 'Nothing new can be issued to them — add the asset, then assign it to someone else.', variant: 'destructive' })
      }
      const chainTo = person && !left ? person.id : null
      setForm({
        note: chainTo
          ? `Nothing is registered yet. Add the first asset — it will be assigned to ${name} straight away.`
          : 'Nothing is registered yet. Add the first asset, then assign it from the register.',
        thenAssignTo: chainTo,
      })
    } else {
      setAssign({ employeeId: person?.id ?? null })
    }
    router.replace('/employees/assets', { scroll: false })
  }, [assignParam, canManage, list.isSuccess, list.data?.total, assignee.isSuccess, assignee.isError, assignee.data, router, toast])

  const rows = useMemo(() => list.data?.data ?? [], [list.data])
  const total = list.data?.total ?? 0
  const truncated = total > rows.length
  const s = summary.data?.data

  const doDelete = async () => {
    if (!deleting) return
    try {
      await del.mutateAsync(deleting.id)
      toast({ title: `${deleting.asset_tag} deleted`, description: deleting.name })
      if (drawerId === deleting.id) setDrawerId(null)
      setDeleting(null)
    } catch (err) {
      // 409 ASSET_ASSIGNED carries "Return the asset first" — show it as-is.
      toast({
        title: 'Could not delete',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
      setDeleting(null)
    }
  }

  const doExport = async () => {
    try {
      await exportCsv.mutateAsync()
    } catch (err) {
      toast({ title: 'Export failed', description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })
    }
  }

  if (!canManage) {
    return (
      <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
          <SectionHead title="Assets" sub="Company equipment — who holds what, and when it came back." />
          <div className="card" style={{ textAlign: 'center', padding: '34px 24px' }}>
            <Icon.lock size={20} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>Owners and admins only</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
              The register is managed by HR. Your own equipment is under My assets.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const forbidden = list.error instanceof APIError && list.error.status === 403

  return (
    <div style={{ padding: '28px 32px 64px', position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1280, margin: '0 auto' }}>
        <SectionHead
          title="Assets"
          sub={
            summary.isLoading
              ? 'Loading…'
              : s
                ? `${s.total} registered · ${s.assigned} out with people · ${s.in_stock} in stock${s.awaiting_acknowledgement ? ` · ${s.awaiting_acknowledgement} awaiting acknowledgement` : ''}`
                : 'Company equipment — who holds what, and when it came back.'
          }
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              {/* The export is the whole register, so it is gated on the summary, not the filtered list. */}
              <Btn kind="secondary" size="sm" icon={<Icon.download size={13} />} onClick={() => void doExport()} disabled={exportCsv.isPending || (s ? s.total === 0 : total === 0)}>
                {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
              </Btn>
              <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setForm({})} data-testid="add-asset">
                Add asset
              </Btn>
            </div>
          }
        />

        {/* KPIs */}
        {summary.isLoading ? (
          <div style={{ marginBottom: 18 }}>
            <SkeletonCards count={4} height={108} />
          </div>
        ) : s ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }} data-testid="asset-kpis">
            <Kpi label="Total" value={s.total} icon={<Icon.laptop size={15} />} accent="blue" />
            <Kpi label="Assigned" value={s.assigned} icon={<Icon.people size={15} />} accent="green" />
            <Kpi label="In stock" value={s.in_stock} icon={<Icon.grid size={15} />} accent="purple" />
            <Kpi
              label="Awaiting acknowledgement"
              value={s.awaiting_acknowledgement}
              icon={<Icon.clock size={15} />}
              accent={s.awaiting_acknowledgement > 0 ? 'yellow' : 'blue'}
              delta={s.awaiting_acknowledgement > 0 ? 'Holders not yet confirmed receipt' : undefined}
              trend="flat"
            />
          </div>
        ) : null}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
            <Icon.search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
            <input
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tag, name, serial, brand…"
              style={{ paddingLeft: 34, height: 38 }}
              data-testid="asset-search"
            />
          </div>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as AssetStatus | '')} style={{ height: 38, width: 160 }} data-testid="asset-filter-status">
            <option value="">All statuses</option>
            {ASSET_STATUSES.map((st) => (
              <option key={st.value} value={st.value}>
                {st.label}
              </option>
            ))}
          </select>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as AssetCategory | '')} style={{ height: 38, width: 170 }} data-testid="asset-filter-category">
            <option value="">All categories</option>
            {ASSET_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {filtersOn && (
            <Btn kind="ghost" size="sm" icon={<Icon.x size={12} />} onClick={() => { setStatus(''); setCategory(''); setQ('') }}>
              Clear
            </Btn>
          )}
        </div>

        {truncated && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, fontWeight: 600, color: 'var(--text-mute)' }}>
            <Icon.info size={13} />
            Showing first {rows.length} of {total} — narrow it down with search or the filters.
          </div>
        )}

        {/* List */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {list.isLoading ? (
            <SkeletonRows rows={6} height={58} />
          ) : list.isError ? (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: forbidden ? 'var(--text-mute)' : 'var(--coral)', marginBottom: 12 }}>
                {forbidden ? 'Only owners and admins can open the register.' : 'Could not load the register.'}
              </div>
              {!forbidden && (
                <Btn kind="secondary" size="sm" icon={<Icon.refresh size={12} />} onClick={() => void list.refetch()}>
                  Retry
                </Btn>
              )}
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '56px 24px', textAlign: 'center' }} data-testid="assets-empty">
              <Icon.laptop size={26} style={{ color: 'var(--text-faint)', marginBottom: 10 }} />
              <div className="t-h3" style={{ marginBottom: 6 }}>{filtersOn ? 'No assets match' : 'No assets yet'}</div>
              <p className="t-mute" style={{ fontSize: 13, maxWidth: 440, margin: '0 auto 16px' }}>
                {filtersOn
                  ? 'Nothing in the register matches these filters.'
                  : 'Laptops, phones, SIMs, ID cards — register what the company hands out, then assign each item to the person holding it.'}
              </p>
              {filtersOn ? (
                <Btn kind="secondary" size="sm" onClick={() => { setStatus(''); setCategory(''); setQ('') }}>
                  Clear filters
                </Btn>
              ) : (
                <Btn kind="primary" size="sm" icon={<Icon.plus size={13} />} onClick={() => setForm({})}>
                  Add your first asset
                </Btn>
              )}
            </div>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl" data-testid="assets-table">
                <thead>
                  <tr>
                    <th style={{ width: 52 }} />
                    <th>Tag</th>
                    <th>Asset</th>
                    <th>Serial</th>
                    <th>Holder</th>
                    <th>Status</th>
                    <th>Condition</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const st = assetStatusMeta(a.status)
                    const cond = assetConditionMeta(a.condition)
                    const holder = a.current_assignment
                    const assignable = !holder && a.status !== 'retired' && a.status !== 'lost'
                    const open = () => setDrawerId(a.id)
                    return (
                      <tr key={a.id} style={{ cursor: 'pointer' }} onClick={open} data-testid="asset-row" data-tag={a.asset_tag}>
                        <td style={{ paddingRight: 0 }}>
                          <AssetThumb src={a.photo_thumb_url} category={a.category} name={a.name} size={36} />
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>{a.asset_tag}</td>
                        <td>
                          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>{a.name}</div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', marginTop: 1 }}>{assetMake(a) || '—'}</div>
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>{a.serial_number || '—'}</td>
                        <td>
                          {holder ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <Avatar name={holder.employee_name} size="sm" src={holder.employee_avatar_url ?? undefined} />
                              <div>
                                <div style={{ fontSize: 12.5, fontWeight: 800 }}>{holder.employee_name}</div>
                                <div style={{ fontSize: 10.5, fontWeight: 600, color: holder.acknowledged_at ? 'var(--text-mute)' : 'var(--yellow)' }}>
                                  {holder.acknowledged_at ? `since ${fmtAssetDate(holder.assigned_at)}` : 'awaiting acknowledgement'}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}>{a.status === 'in_stock' ? 'In stock' : '—'}</span>
                          )}
                        </td>
                        <td>
                          <Pill tone={st.tone} dot>{st.label}</Pill>
                        </td>
                        <td>
                          <Pill tone={cond.tone}>{cond.label}</Pill>
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtAssetDate(a.updated_at)}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            {holder ? (
                              <Btn kind="secondary" size="sm" icon={<Icon.swap size={12} />} onClick={() => setReturning(a)} data-testid="row-return">
                                Return
                              </Btn>
                            ) : assignable ? (
                              <Btn kind="secondary" size="sm" icon={<Icon.userPlus size={12} />} onClick={() => setAssign({ asset: a })} data-testid="row-assign">
                                Assign
                              </Btn>
                            ) : null}
                            <Btn kind="ghost" size="sm" icon={<Icon.edit size={12} />} onClick={() => setForm({ asset: a })} data-testid="row-edit">
                              Edit
                            </Btn>
                            <Popover open={menuRow === a.id} onOpenChange={(o) => setMenuRow(o ? a.id : null)}>
                              <PopoverTrigger asChild>
                                <Btn kind="ghost" size="sm" icon={<Icon.more size={14} />} aria-label="More" data-testid="row-more" />
                              </PopoverTrigger>
                              <PopoverContent style={{ padding: 6, width: 180 }}>
                                <MenuItem
                                  onClick={() => {
                                    setMenuRow(null)
                                    open()
                                  }}
                                >
                                  <Icon.eye size={13} /> View details
                                </MenuItem>
                                <MenuItem
                                  danger
                                  disabled={!!holder}
                                  title={holder ? 'Return the asset first' : undefined}
                                  onClick={() => {
                                    setMenuRow(null)
                                    setDeleting(a)
                                  }}
                                >
                                  <Icon.trash size={13} /> Delete
                                </MenuItem>
                              </PopoverContent>
                            </Popover>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Detail drawer */}
      <AssetDrawer
        assetId={drawerId}
        onClose={() => setDrawerId(null)}
        onAssign={(a) => setAssign({ asset: a })}
        onReturn={(a) => setReturning(a)}
        onEdit={(a) => setForm({ asset: a })}
        onDelete={(a) => setDeleting(a)}
      />

      {/* Add / Edit */}
      <AssetFormModal
        open={!!form}
        onClose={() => setForm(null)}
        asset={form?.asset ?? null}
        note={form?.note}
        onCreated={(created) => {
          if (form?.thenAssignTo) setAssign({ asset: created, employeeId: form.thenAssignTo })
        }}
      />

      {/* Assign */}
      <AssignAssetModal
        open={!!assign}
        onClose={() => setAssign(null)}
        asset={assign?.asset ?? null}
        employeeId={assign?.employeeId ?? null}
        onAddAsset={() => {
          const who = assign?.employeeId ?? null
          setAssign(null)
          setForm({ note: 'Add the item you are handing over — it will be assigned straight away.', thenAssignTo: who })
        }}
      />

      {/* Return */}
      <ReturnAssetModal open={!!returning} onClose={() => setReturning(null)} asset={returning} />

      {/* Delete */}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => !del.isPending && setDeleting(null)}
        title={`Delete ${deleting?.asset_tag ?? 'asset'}`}
        body={
          deleting
            ? `${deleting.name} leaves the register and the CSV export. Its assignment history is kept on the people who held it. The tag ${deleting.asset_tag} stays reserved.`
            : undefined
        }
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        loadingLabel="Deleting…"
        onConfirm={() => void doDelete()}
      />
    </div>
  )
}
