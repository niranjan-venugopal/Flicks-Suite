'use client'

import { useEffect, useMemo, useState } from 'react'
import { Avatar, Btn, Icon, Modal, Pill } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import {
  UI_STATUS_LABELS,
  deriveUiStatus,
  useEmployee,
  useEmployees,
  type Employee,
  type EmployeeDetail,
} from '@/lib/api/queries/use-employees'
import {
  ASSET_CONDITIONS,
  ASSETS_PAGE_MAX,
  assetConditionMeta,
  useAssets,
  useAssignAsset,
  type Asset,
  type AssetCondition,
  type AssetDetail,
} from '@/lib/api/queries/use-assets'
import { AssetThumb } from './AssetThumb'
import { assetMake, todayISO } from './format'
import { useDebounced } from './useDebounced'

/**
 * Round P R4 — hand an asset to a person. Two entry points share the form:
 *  · from the register / drawer: `asset` is fixed, pick the person;
 *  · from onboarding ("Assign equipment") / the employee 360: `employeeId`
 *    is fixed, pick an in-stock asset.
 * Both can be given (the ?assign= flow after "Add asset") — then it is just
 * date + condition + notes. The person list is everyone except separated /
 * absconded (HR assigns DURING onboarding, so invited / onboarding people
 * are in), with their status beside the name; the server enforces the same
 * rule, so a pre-selected person who has left is never offered back — the
 * modal says so and asks for someone else. Nothing in stock is never a dead
 * end: the modal offers "Add asset".
 */

const EXCLUDED = new Set(['separated', 'absconded'])
const SEARCH_DEBOUNCE_MS = 300

/** What the picker needs of a person — roster rows have it; a 360 detail is adapted. */
type PersonOption = Pick<Employee, 'id' | 'name' | 'email' | 'employeeCode' | 'rawStatus' | 'uiStatus' | 'avatarUrl'>

function fromDetail(d: EmployeeDetail): PersonOption {
  return {
    id: d.id,
    name: [d.firstName, d.lastName].filter(Boolean).join(' ') || d.userFullName || d.workEmail,
    email: d.workEmail || d.userEmail || '',
    employeeCode: d.employeeCode || undefined,
    rawStatus: d.status,
    uiStatus: deriveUiStatus(d),
    avatarUrl: d.avatarUrl ?? undefined,
  }
}

function personLabel(e: PersonOption): string {
  const bits = [e.name]
  if (e.employeeCode) bits.push(e.employeeCode)
  return `${bits.join(' · ')} — ${UI_STATUS_LABELS[e.uiStatus] ?? e.uiStatus}`
}

export function AssignAssetModal({
  open,
  onClose,
  asset,
  employeeId,
  onAssigned,
  onAddAsset,
}: {
  open: boolean
  onClose: () => void
  /** The asset to hand over. Omit to pick one from stock for `employeeId`. */
  asset?: Asset | AssetDetail | null
  /** Pre-selected person (still changeable). */
  employeeId?: string | null
  onAssigned?: (detail: AssetDetail) => void
  /** Pick-an-asset mode with nothing in stock: lets the page open "Add asset". */
  onAddAsset?: () => void
}) {
  const { toast } = useToast()
  const assign = useAssignAsset()
  const pickAsset = !asset

  const [personId, setPersonId] = useState(employeeId ?? '')
  const [personQ, setPersonQ] = useState('')
  const [pickedAsset, setPickedAsset] = useState<Asset | null>(null)
  const [assetQ, setAssetQ] = useState('')
  const [issueDate, setIssueDate] = useState(todayISO())
  const [condition, setCondition] = useState<AssetCondition>(asset?.condition ?? 'good')
  const [conditionTouched, setConditionTouched] = useState(false)
  const [notes, setNotes] = useState('')

  // Reset during render when the modal opens or is handed a different
  // asset / person (see AssetFormModal for why not an effect).
  const [prevKey, setPrevKey] = useState<string | null>(null)
  const key = open ? `${asset?.id ?? ''}|${employeeId ?? ''}` : null
  if (key !== prevKey) {
    setPrevKey(key)
    if (key !== null) {
      setPersonId(employeeId ?? '')
      setPersonQ('')
      setPickedAsset(null)
      setAssetQ('')
      setIssueDate(todayISO())
      setCondition(asset?.condition ?? 'good')
      setConditionTouched(false)
      setNotes('')
    }
  }

  const people = useEmployees({ limit: 100 }, { enabled: open })
  // The pre-selected person by id (shares the page's cache entry): they may
  // sit beyond the roster's first 100 rows, or have left since the link was
  // made — either way the roster alone cannot say.
  const preselected = useEmployee(open && employeeId ? employeeId : '')
  // Stock is searched server-side (tag / name / serial / brand / model) so a
  // register with more than one page in stock is still reachable from here.
  const dAssetQ = useDebounced(assetQ, SEARCH_DEBOUNCE_MS)
  const stock = useAssets({ status: 'in_stock', q: dAssetQ, limit: ASSETS_PAGE_MAX }, { enabled: open && pickAsset })

  const roster = useMemo(() => people.data?.employees ?? [], [people.data])
  const candidates = useMemo(() => {
    const all = roster.filter((e) => !EXCLUDED.has(e.rawStatus))
    const q = personQ.trim().toLowerCase()
    const list = q
      ? all.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.email.toLowerCase().includes(q) ||
            (e.employeeCode ?? '').toLowerCase().includes(q),
        )
      : all
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [roster, personQ])

  // Who is selected, resolved only among people who can receive equipment:
  // the roster row, else the detail lookup for a pre-selected id beyond the
  // first page. Someone separated / absconded resolves to nobody — and is
  // named below so HR knows why the field is empty.
  const detail = preselected.data && preselected.data.id === personId ? preselected.data : null
  const selectedPerson: PersonOption | null = useMemo(() => {
    if (!personId) return null
    const row = roster.find((e) => e.id === personId)
    if (row) return EXCLUDED.has(row.rawStatus) ? null : row
    if (detail && !EXCLUDED.has(detail.status)) return fromDetail(detail)
    return null
  }, [personId, roster, detail])
  const leftPerson: PersonOption | null = useMemo(() => {
    if (!personId || selectedPerson) return null
    const row = roster.find((e) => e.id === personId)
    if (row && EXCLUDED.has(row.rawStatus)) return row
    if (detail && EXCLUDED.has(detail.status)) return fromDetail(detail)
    return null
  }, [personId, selectedPerson, roster, detail])
  // Keep the selected person selectable even when the search hides them.
  const personOptions = selectedPerson && !candidates.some((e) => e.id === personId) ? [selectedPerson, ...candidates] : candidates

  const stockRows = useMemo(() => {
    const rows = stock.data?.data ?? []
    // The picked asset stays in the list while a later search excludes it.
    return pickedAsset && !rows.some((a) => a.id === pickedAsset.id) ? [pickedAsset, ...rows] : rows
  }, [stock.data, pickedAsset])
  const stockTotal = stock.data?.total ?? 0
  const stockTruncated = stockTotal > (stock.data?.data.length ?? 0)
  const chosen: Asset | AssetDetail | null = asset ?? pickedAsset

  // The issue condition follows the chosen asset until HR overrides it.
  useEffect(() => {
    if (!conditionTouched && chosen) setCondition(chosen.condition)
  }, [chosen, conditionTouched])

  // Only certain with no search narrowing the answer.
  const nothingInStock = pickAsset && stock.isSuccess && !dAssetQ.trim() && stockTotal === 0
  const canSubmit = !!selectedPerson && !!chosen && !assign.isPending

  const submit = async () => {
    if (!chosen || !selectedPerson) return
    const who = selectedPerson.name
    try {
      const res = await assign.mutateAsync({
        id: chosen.id,
        payload: {
          employee_id: selectedPerson.id,
          // Today = "now" (server default); an earlier day is pinned to local noon.
          ...(issueDate && issueDate !== todayISO() ? { assigned_at: new Date(`${issueDate}T12:00:00`).toISOString() } : {}),
          issue_condition: condition,
          notes: notes.trim() || null,
        },
      })
      toast({
        title: `Assigned to ${who} — they'll be asked to acknowledge receipt`,
        description: `${chosen.asset_tag} · ${chosen.name}`,
      })
      onAssigned?.(res.data)
      onClose()
    } catch (err) {
      toast({
        title: 'Could not assign',
        description: err instanceof Error ? err.message : 'Try again',
        variant: 'destructive',
      })
    }
  }

  const title = pickAsset ? 'Assign equipment' : `Assign ${asset?.asset_tag}`
  const sub = pickAsset
    ? selectedPerson
      ? `Pick what ${selectedPerson.name} is getting.`
      : 'Pick an asset from stock and the person receiving it.'
    : asset?.name

  return (
    <Modal
      open={open}
      onClose={assign.isPending ? () => {} : onClose}
      title={title}
      sub={sub}
      width={560}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={assign.isPending}>
            Cancel
          </Btn>
          {nothingInStock && onAddAsset ? (
            <Btn kind="primary" icon={<Icon.plus size={14} />} onClick={onAddAsset}>
              Add asset
            </Btn>
          ) : (
            <Btn kind="primary" icon={<Icon.userPlus size={14} />} onClick={() => void submit()} disabled={!canSubmit} data-testid="assign-submit">
              {assign.isPending ? 'Assigning…' : 'Assign'}
            </Btn>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Asset */}
        {asset ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, background: 'var(--surf-1)', border: '1px solid var(--bord)' }}>
            <AssetThumb src={asset.photo_thumb_url} category={asset.category} name={asset.name} size={44} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', marginRight: 8 }}>{asset.asset_tag}</span>
                {asset.name}
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-mute)', marginTop: 2 }}>
                {assetMake(asset) || 'No brand / model'}
                {asset.serial_number ? ` · SN ${asset.serial_number}` : ''}
              </div>
            </div>
            <Pill tone={assetConditionMeta(asset.condition).tone}>{assetConditionMeta(asset.condition).label}</Pill>
          </div>
        ) : nothingInStock ? (
          <div style={{ padding: '18px 16px', borderRadius: 12, border: '1px dashed var(--bord-2)', textAlign: 'center' }}>
            <Icon.laptop size={20} style={{ color: 'var(--text-faint)', marginBottom: 8 }} />
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>Nothing in stock right now</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Every registered asset is out with someone, under repair or retired. Add the item you are handing over and it will be assigned straight away.
            </div>
          </div>
        ) : (
          <div>
            <label className="label">Asset</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ position: 'relative' }}>
                <Icon.search size={13} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
                <input
                  className="input"
                  value={assetQ}
                  onChange={(e) => setAssetQ(e.target.value)}
                  placeholder="Search tag, name, serial…"
                  style={{ paddingLeft: 34, height: 38 }}
                />
              </div>
              <select
                className="input"
                value={pickedAsset?.id ?? ''}
                onChange={(e) => setPickedAsset(stockRows.find((a) => a.id === e.target.value) ?? null)}
                disabled={!stock.data && stock.isFetching}
                data-testid="assign-asset"
              >
                <option value="">
                  {!stock.data && stock.isFetching ? 'Loading stock…' : stockRows.length ? 'Choose an asset' : 'No in-stock asset matches'}
                </option>
                {stockRows.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.asset_tag} · {a.name}
                    {assetMake(a) ? ` (${assetMake(a)})` : ''}
                  </option>
                ))}
              </select>
              {stockTruncated && (
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.45 }}>
                  Showing the first {stock.data?.data.length} of {stockTotal} in stock — search by tag, name or serial to find the rest.
                </div>
              )}
              {stock.isError && (
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--coral)' }}>
                  Could not load stock.{' '}
                  <button type="button" onClick={() => void stock.refetch()} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontWeight: 800, padding: 0 }}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Person */}
        {!nothingInStock && (
          <div>
            <label className="label">Hand over to</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {selectedPerson && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar name={selectedPerson.name} size="sm" src={selectedPerson.avatarUrl} />
                  <div style={{ fontSize: 12.5, fontWeight: 800, flex: 1, minWidth: 0 }}>
                    {selectedPerson.name}
                    {selectedPerson.employeeCode && (
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-mute)', fontWeight: 700, marginLeft: 8 }}>{selectedPerson.employeeCode}</span>
                    )}
                  </div>
                  <Pill tone={selectedPerson.uiStatus === 'active' ? 'green' : 'blue'} dot>
                    {UI_STATUS_LABELS[selectedPerson.uiStatus] ?? selectedPerson.uiStatus}
                  </Pill>
                </div>
              )}
              {leftPerson && (
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 10, background: 'rgba(254, 216, 0, 0.07)', border: '1px solid rgba(254, 216, 0, 0.22)', fontSize: 12, fontWeight: 700, lineHeight: 1.4 }}
                  data-testid="assign-person-left"
                >
                  <Icon.warn size={14} style={{ color: 'var(--yellow)', flexShrink: 0 }} />
                  <span>
                    {leftPerson.name} has left the company ({UI_STATUS_LABELS[leftPerson.uiStatus] ?? leftPerson.uiStatus}) — pick someone else.
                  </span>
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <Icon.search size={13} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
                <input
                  className="input"
                  value={personQ}
                  onChange={(e) => setPersonQ(e.target.value)}
                  placeholder="Search by name, email or code…"
                  style={{ paddingLeft: 34, height: 38 }}
                  data-testid="assign-person-search"
                />
              </div>
              <select
                className="input"
                value={selectedPerson ? selectedPerson.id : ''}
                onChange={(e) => setPersonId(e.target.value)}
                disabled={people.isLoading}
                data-testid="assign-person"
              >
                <option value="">{people.isLoading ? 'Loading people…' : personOptions.length ? 'Choose a person' : 'Nobody matches'}</option>
                {personOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {personLabel(e)}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', lineHeight: 1.45 }}>
                People who are still onboarding can receive equipment — their day-one kit goes on record before they sign in. Separated and absconded people are left out.
                {(people.data?.total ?? 0) > (people.data?.employees.length ?? 0) ? ` Showing the first ${people.data?.employees.length} of ${people.data?.total} people.` : ''}
              </div>
              {people.isError && (
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--coral)' }}>
                  Could not load people.{' '}
                  <button type="button" onClick={() => void people.refetch()} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontWeight: 800, padding: 0 }}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {!nothingInStock && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label className="label">Issued on</label>
              <DateField value={issueDate} onChange={setIssueDate} max={todayISO()} />
            </div>
            <div>
              <label className="label">Condition at handover</label>
              <select
                className="input"
                value={condition}
                onChange={(e) => {
                  setConditionTouched(true)
                  setCondition(e.target.value as AssetCondition)
                }}
                data-testid="assign-condition"
              >
                {ASSET_CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <label className="label">Notes for the person</label>
              <textarea
                className="input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Charger + sleeve included. Return on your last day."
                style={{ height: 'auto', resize: 'vertical', paddingTop: 9, paddingBottom: 9 }}
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
