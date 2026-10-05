'use client'

import { useEffect, useState } from 'react'
import { Btn, Icon, Modal } from '@/components/proto'
import { DateField } from '@/components/ui/date-picker'
import { useToast } from '@/components/ui/use-toast'
import {
  ASSET_CATEGORIES,
  ASSET_CONDITIONS,
  ASSET_STATUSES,
  useCreateAsset,
  useNextAssetTag,
  useRemoveAssetPhoto,
  useUpdateAsset,
  useUploadAssetPhotoById,
  type Asset,
  type AssetCategory,
  type AssetCondition,
  type AssetDetail,
  type AssetStatus,
  type CreateAssetPayload,
  type UpdateAssetPayload,
} from '@/lib/api/queries/use-assets'
import { AssetPhotoField } from './AssetPhotoField'
import { todayISO } from './format'

/**
 * Round P R4 — Add / Edit asset. One form for both: create POSTs then
 * uploads the picked photo against the new id; edit PATCHes only the fields
 * that changed, then applies the photo change (Replace → upload, Remove →
 * /photo/remove). Validation mirrors the DTO (tag charset + 32 chars, name
 * ≤ 120, amount ≥ 0 with 2 dp, 3-letter currency) so the common mistakes
 * read inline instead of as a 400. API errors (409 ASSET_TAG_TAKEN …) surface
 * in a toast with the server's own message.
 */

const TAG_RE = /^[A-Za-z0-9._/-]+$/
const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/
const EDITABLE_STATUSES = ASSET_STATUSES.filter((s) => s.value !== 'assigned')

interface FormState {
  asset_tag: string
  name: string
  category: AssetCategory
  brand: string
  model: string
  serial_number: string
  purchase_date: string
  purchase_value: string
  currency: string
  condition: AssetCondition
  status: Exclude<AssetStatus, 'assigned'>
  notes: string
}

function fromAsset(a: Asset | null | undefined): FormState {
  return {
    asset_tag: a?.asset_tag ?? '',
    name: a?.name ?? '',
    category: a?.category ?? 'laptop',
    brand: a?.brand ?? '',
    model: a?.model ?? '',
    serial_number: a?.serial_number ?? '',
    purchase_date: a?.purchase_date ?? '',
    purchase_value: a?.purchase_value ? String(Number(a.purchase_value)) : '',
    currency: a?.currency ?? 'INR',
    condition: a?.condition ?? 'good',
    status: a && a.status !== 'assigned' ? a.status : 'in_stock',
    notes: a?.notes ?? '',
  }
}

function Field({ label, children, hint, span }: { label: string; children: React.ReactNode; hint?: string; span?: 2 }) {
  return (
    <div style={{ gridColumn: span === 2 ? 'span 2' : 'auto', minWidth: 0 }}>
      <label className="label">{label}</label>
      {children}
      {hint && (
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-mute)', marginTop: 5, lineHeight: 1.4 }}>{hint}</div>
      )}
    </div>
  )
}

export function AssetFormModal({
  open,
  onClose,
  asset,
  onCreated,
  onSaved,
  note,
}: {
  open: boolean
  onClose: () => void
  /** Edit when given; create otherwise. */
  asset?: Asset | AssetDetail | null
  /** Create only — fires with the saved row (photo uploaded first when one was picked). */
  onCreated?: (asset: Asset) => void
  /** Edit only — the fresh detail after every change landed. */
  onSaved?: (detail: AssetDetail) => void
  /** Context line under the title, e.g. "Add the first asset, then assign it to Priya." */
  note?: string
}) {
  const isEdit = !!asset
  const { toast } = useToast()
  const create = useCreateAsset()
  const update = useUpdateAsset()
  const upload = useUploadAssetPhotoById()
  const removePhoto = useRemoveAssetPhoto()
  const nextTag = useNextAssetTag(open && !isEdit)

  const [form, setForm] = useState<FormState>(() => fromAsset(asset))
  const [tagTouched, setTagTouched] = useState(false)
  const [pendingPhoto, setPendingPhoto] = useState<Blob | null>(null)
  const [dropPhoto, setDropPhoto] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [saving, setSaving] = useState(false)

  // Reset on every open (and when a different asset is handed in) so a
  // cancelled edit never leaks into the next one. Done during render, not in
  // an effect: an effect commits one frame after the inputs paint, which both
  // flashes stale values and races anything typed in that frame.
  const [prevOpen, setPrevOpen] = useState(false)
  const [prevAssetId, setPrevAssetId] = useState<string | null>(null)
  const assetId = asset?.id ?? null
  if (open !== prevOpen || (open && assetId !== prevAssetId)) {
    setPrevOpen(open)
    setPrevAssetId(assetId)
    if (open) {
      setForm(fromAsset(asset))
      setTagTouched(false)
      setPendingPhoto(null)
      setDropPhoto(false)
      setErrors({})
    }
  }

  // Prefill the suggested tag until the user types their own. The cached
  // suggestion lands first and the staleTime-0 refetch may bring a newer
  // number (another admin added one, or the post-create refetch was still in
  // flight) — so the latest suggestion always replaces the earlier one;
  // `tagTouched` is what protects a hand-typed tag.
  useEffect(() => {
    if (!open || isEdit || tagTouched) return
    const suggested = nextTag.data?.data.asset_tag
    if (suggested) setForm((f) => (f.asset_tag === suggested ? f : { ...f, asset_tag: suggested }))
  }, [open, isEdit, tagTouched, nextTag.data])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }))
  }

  const held = isEdit && asset?.status === 'assigned'

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {}
    const tag = form.asset_tag.trim()
    if (tag && (tag.length > 32 || !TAG_RE.test(tag))) {
      next.asset_tag = 'Letters, digits, dots, underscores, slashes and dashes only (max 32).'
    }
    if (isEdit && !tag) next.asset_tag = 'An asset needs a tag.'
    if (!form.name.trim()) next.name = 'Give the asset a name.'
    else if (form.name.trim().length > 120) next.name = 'Keep the name under 120 characters.'
    for (const k of ['brand', 'model', 'serial_number'] as const) {
      if (form[k].trim().length > 120) next[k] = 'Max 120 characters.'
    }
    const value = form.purchase_value.trim()
    if (value && !AMOUNT_RE.test(value)) next.purchase_value = 'A non-negative amount with up to 2 decimals.'
    if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) next.currency = '3-letter code, e.g. INR.'
    if (form.notes.length > 2000) next.notes = 'Max 2000 characters.'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const fail = (title: string, err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : 'Try again', variant: 'destructive' })

  const submit = async () => {
    if (!validate()) return
    setSaving(true)
    try {
      if (!isEdit) {
        const payload: CreateAssetPayload = {
          asset_tag: form.asset_tag.trim() || undefined,
          name: form.name.trim(),
          category: form.category,
          brand: form.brand.trim() || null,
          model: form.model.trim() || null,
          serial_number: form.serial_number.trim() || null,
          purchase_date: form.purchase_date || null,
          purchase_value: form.purchase_value.trim() || null,
          currency: form.currency.trim().toUpperCase(),
          condition: form.condition,
          notes: form.notes.trim() || null,
        }
        let created: Asset
        try {
          created = (await create.mutateAsync(payload)).data
        } catch (err) {
          fail('Could not add the asset', err)
          return
        }
        let photoFailed = false
        if (pendingPhoto) {
          try {
            await upload.mutateAsync({ id: created.id, blob: pendingPhoto })
          } catch (err) {
            photoFailed = true
            toast({
              title: `${created.asset_tag} saved, but the photo did not upload`,
              description: err instanceof Error ? err.message : 'Open the asset and use Replace photo.',
              variant: 'destructive',
            })
          }
        }
        if (!photoFailed) toast({ title: `${created.asset_tag} added`, description: created.name })
        onCreated?.(created)
        onClose()
        return
      }

      // Edit: only what changed.
      const a = asset!
      const payload: UpdateAssetPayload = {}
      const tag = form.asset_tag.trim()
      if (tag !== a.asset_tag) payload.asset_tag = tag
      if (form.name.trim() !== a.name) payload.name = form.name.trim()
      if (form.category !== a.category) payload.category = form.category
      if ((form.brand.trim() || null) !== (a.brand ?? null)) payload.brand = form.brand.trim() || null
      if ((form.model.trim() || null) !== (a.model ?? null)) payload.model = form.model.trim() || null
      if ((form.serial_number.trim() || null) !== (a.serial_number ?? null)) payload.serial_number = form.serial_number.trim() || null
      if ((form.purchase_date || null) !== (a.purchase_date ?? null)) payload.purchase_date = form.purchase_date || null
      const curValue = a.purchase_value ? Number(a.purchase_value) : null
      const newValue = form.purchase_value.trim() ? Number(form.purchase_value.trim()) : null
      if (curValue !== newValue) payload.purchase_value = form.purchase_value.trim() || null
      if (form.currency.trim().toUpperCase() !== a.currency) payload.currency = form.currency.trim().toUpperCase()
      if (form.condition !== a.condition) payload.condition = form.condition
      if (!held && form.status !== a.status) payload.status = form.status
      if ((form.notes.trim() || null) !== (a.notes ?? null)) payload.notes = form.notes.trim() || null

      let latest: AssetDetail | null = null
      try {
        if (Object.keys(payload).length > 0) latest = (await update.mutateAsync({ id: a.id, payload })).data
        if (dropPhoto && a.photo_url && !pendingPhoto) latest = (await removePhoto.mutateAsync(a.id)).data
        if (pendingPhoto) latest = (await upload.mutateAsync({ id: a.id, blob: pendingPhoto })).data
      } catch (err) {
        fail('Could not save', err)
        return
      }
      toast({ title: 'Asset updated', description: `${form.asset_tag.trim()} · ${form.name.trim()}` })
      if (latest) onSaved?.(latest)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const title = isEdit ? `Edit ${asset?.asset_tag}` : 'Add asset'
  const sub = note ?? (isEdit ? asset?.name : 'Register a laptop, phone, SIM, ID card or anything else the company hands out.')

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={title}
      sub={sub}
      width={640}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn kind="primary" icon={<Icon.check size={14} />} onClick={() => void submit()} disabled={saving} data-testid="asset-form-save">
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add asset'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <AssetPhotoField
          currentUrl={dropPhoto ? null : (asset?.photo_url ?? null)}
          pending={pendingPhoto}
          category={form.category}
          onPick={(blob) => {
            setPendingPhoto(blob)
            setDropPhoto(false)
          }}
          onClear={() => {
            if (pendingPhoto) setPendingPhoto(null)
            else setDropPhoto(true)
          }}
          disabled={saving}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field
            label="Asset tag"
            hint={errors.asset_tag ?? (isEdit ? 'Unique in the company.' : 'Leave blank for the next number.')}
          >
            <input
              className="input"
              value={form.asset_tag}
              onChange={(e) => {
                setTagTouched(true)
                set('asset_tag', e.target.value)
              }}
              placeholder={nextTag.data?.data.asset_tag ?? 'AST-0001'}
              maxLength={32}
              style={{ fontFamily: 'var(--font-mono)', borderColor: errors.asset_tag ? 'var(--coral)' : undefined }}
              autoFocus={isEdit}
              data-testid="asset-tag"
            />
          </Field>
          <Field label="Category">
            <select className="input" value={form.category} onChange={(e) => set('category', e.target.value as AssetCategory)} data-testid="asset-category">
              {ASSET_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" span={2} hint={errors.name}>
            <input
              className="input"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder='e.g. MacBook Air M3 13"'
              maxLength={120}
              style={{ borderColor: errors.name ? 'var(--coral)' : undefined }}
              autoFocus={!isEdit}
              data-testid="asset-name"
            />
          </Field>
          <Field label="Brand" hint={errors.brand}>
            <input className="input" value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Apple" maxLength={120} />
          </Field>
          <Field label="Model" hint={errors.model}>
            <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="A3113" maxLength={120} />
          </Field>
          <Field label="Serial number" span={2} hint={errors.serial_number}>
            <input
              className="input"
              value={form.serial_number}
              onChange={(e) => set('serial_number', e.target.value)}
              placeholder="From the sticker or Settings → About"
              maxLength={120}
              style={{ fontFamily: 'var(--font-mono)' }}
              data-testid="asset-serial"
            />
          </Field>
          <Field label="Purchase date">
            <DateField value={form.purchase_date} onChange={(v) => set('purchase_date', v)} max={todayISO()} placeholder="Optional" />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 86px', gap: 8, minWidth: 0 }}>
            <Field label="Purchase value" hint={errors.purchase_value}>
              <input
                className="input"
                inputMode="decimal"
                value={form.purchase_value}
                onChange={(e) => set('purchase_value', e.target.value)}
                placeholder="0.00"
                style={{ borderColor: errors.purchase_value ? 'var(--coral)' : undefined }}
              />
            </Field>
            <Field label="Currency" hint={errors.currency}>
              <input
                className="input"
                value={form.currency}
                onChange={(e) => set('currency', e.target.value.toUpperCase())}
                maxLength={3}
                style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', borderColor: errors.currency ? 'var(--coral)' : undefined, padding: '0 10px' }}
              />
            </Field>
          </div>
          <Field label="Condition">
            <select className="input" value={form.condition} onChange={(e) => set('condition', e.target.value as AssetCondition)} data-testid="asset-condition">
              {ASSET_CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {isEdit && (
            <Field
              label="Status"
              hint={
                held
                  ? `Assigned to ${asset?.current_assignment?.employee_name ?? 'someone'} — record the return to change it.`
                  : '"Assigned" is set by assigning, not here.'
              }
            >
              <select
                className="input"
                value={held ? 'assigned' : form.status}
                onChange={(e) => set('status', e.target.value as FormState['status'])}
                disabled={held}
                data-testid="asset-status"
              >
                {held && <option value="assigned">Assigned</option>}
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Notes" span={2} hint={errors.notes}>
            <textarea
              className="input"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Charger included, warranty till…, accessories, anything the next holder should know."
              style={{ height: 'auto', resize: 'vertical', paddingTop: 9, paddingBottom: 9 }}
            />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
